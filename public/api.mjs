import { createGame, applyRound, undoLastRound, finishGame, validatePlayers } from './rules.mjs';
import { gameStats, userStats } from './stats.mjs';

const config = window.SCOREKEEPER_CONFIG || {};
const DATA_KEY = 'five-card-v2-local-data';
const KEYS_KEY = `five-card-v2-keys:${config.envId || 'local'}`;
const LEGACY_KEY = `five-card-session:${config.envId || 'local'}`;
export const mode = () => config.envId ? 'cloud' : 'local';
const clone = value => JSON.parse(JSON.stringify(value));
function stored(key, fallback = null) {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { throw new Error('本机记录读取失败，请保留浏览器数据并联系维护者。'); }
}
export function gameKey(id) { return stored(KEYS_KEY, {})[id] || null; }
export function saveGameKey(id, key) {
  const keys = stored(KEYS_KEY, {});
  if (key) keys[id] = key;
  else delete keys[id];
  localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
}
export function legacySession() { return stored(LEGACY_KEY); }
export function clearLegacySession() { localStorage.removeItem(LEGACY_KEY); }
function readLegacyLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('room') && params.get('read')) {
    const old = legacySession();
    const credentials = {roomId:params.get('room'),readKey:params.get('read')};
    if (old?.roomId === credentials.roomId && old.writeKey) credentials.writeKey = old.writeKey;
    localStorage.setItem(LEGACY_KEY,JSON.stringify(credentials));
  }
}
readLegacyLink();
window.addEventListener?.('hashchange', readLegacyLink);
function randomHex(size = 16) {
  return [...crypto.getRandomValues(new Uint8Array(size))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function randomKey() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const failure = (code, message) => Object.assign(new Error(message),{code,isApiFailure:true});
function cloudFailure(error) {
  if (error?.isApiFailure) return error;
  const code = String(error?.code || error?.error?.code || 'CLOUD_CONNECTION');
  const raw = typeof error === 'string' ? error : error?.message || error?.errMsg || error?.error?.message || '';
  const message = typeof raw === 'string' ? raw : '';
  if (code === 'LOGIN_TYPE_DISABLED') return failure(code,'云端访客登录已停用，请联系维护者恢复访问。');
  if (/network|fetch|网络|timeout|超时/i.test(`${code} ${message}`)) return failure(code,'连接云端失败，请检查网络后重试。');
  if (/login|auth|credential|token|登录|身份/i.test(`${code} ${message}`)) return failure(code,`云端身份验证未完成（${code}），请重试。`);
  return failure(code,message || `云端连接暂时失败（${code}），请重试。`);
}
function cleanName(value) {
  if (typeof value !== 'string') throw failure('VALIDATION','请填写用户昵称');
  const name = value.normalize('NFKC').trim();
  if (!name || [...name].length > 20 || /[\u0000-\u001f\u007f]/u.test(name)) throw failure('VALIDATION','昵称须为 1～20 个可见字符');
  return name;
}
function expose(game) {
  const {writeKeyHash,...clean} = game;
  return {...clone(clean),roundCount:game.rounds.length,statistics:gameStats(game)};
}
function summary(game) { const {rounds,...clean} = expose(game); return clean; }
async function localLegacy() {
  const saved = legacySession();
  if (!saved) throw failure('NOT_FOUND','当前设备没有可读取的旧版记录');
  const room = stored('five-card-local-room:' + saved.roomId);
  if (!room) throw failure('NOT_FOUND','当前浏览器没有这份旧版记录');
  const reader = saved.readKey && await digest(saved.readKey) === room.readHash;
  const writer = saved.writeKey && await digest(saved.writeKey) === room.writeHash;
  if (!reader && !writer) throw failure('UNAUTHORIZED','旧版记录的查看链接或管理密钥无效');
  const {readHash,writeHash,...visible} = room;
  return {room:visible};
}
async function localRequest(action, payload = {}, expectedVersion) {
  if (action === 'getLegacyRoom') return localLegacy();
  // Complete async key calculation before reading the current shared state.
  const idForKey = payload.gameId || '';
  const key = gameKey(idForKey);
  const keyHash = key ? await digest(`${idForKey}:write:${key}`) : null;
  let proposedUser;
  if (action === 'createUser') {
    const name = cleanName(payload.name);
    proposedUser = {id:'u_' + (await digest(name.toLocaleLowerCase('en-US'))).slice(0,32),name,createdAt:new Date().toISOString()};
  }
  let newWriteKey, newWriteHash, newGameId;
  if (action === 'createGame') {
    newGameId = 'g_' + randomHex(); newWriteKey = randomKey();
    newWriteHash = await digest(`${newGameId}:write:${newWriteKey}`);
  }
  let legacyForImport;
  if (action === 'importLegacy') {
    const source = stored('five-card-local-room:' + payload.roomId);
    if (!source || !payload.writeKey || await digest(payload.writeKey) !== source.writeHash) throw failure('UNAUTHORIZED','导入需要原记录的管理密钥');
    legacyForImport = {source,users:[],games:[],keys:{}};
    for (const old of source.games) {
      const users = [];
      for (const name of old.players) {
        const clean = cleanName(name);
        users.push({id:'u_' + (await digest(clean.toLocaleLowerCase('en-US'))).slice(0,32),name:clean,createdAt:new Date().toISOString()});
      }
      const id = 'g_legacy_' + old.id;
      const importedKey = randomKey();
      legacyForImport.users.push(...users);
      legacyForImport.games.push({...clone(old),id,title:`${source.title || '旧版'} · 第 ${source.games.indexOf(old)+1} 场`,playerIds:users.map(u=>u.id),version:0,kind:'game',updatedAt:old.finishedAt || old.createdAt,writeKeyHash:await digest(`${id}:write:${importedKey}`)});
      legacyForImport.keys[id] = importedKey;
    }
  }
  const execute = () => {
    const data = stored(DATA_KEY,{users:[],games:[]});
    const persist = () => localStorage.setItem(DATA_KEY,JSON.stringify(data));
    if (action === 'listUsers') return {users:clone(data.users)};
    if (action === 'createUser') {
      if (data.users.some(u=>u.id === proposedUser.id)) throw failure('DUPLICATE_USER','这个昵称已经存在，请选择已有用户');
      data.users.push(proposedUser); persist(); return {user:clone(proposedUser)};
    }
    if (action === 'listGames') {
      const sorted = [...data.games].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      const offset = Math.max(0,Number(payload.cursor) || 0), limit = Math.min(100,Math.max(1,Number(payload.limit) || 100));
      return {games:sorted.slice(offset,offset+limit).map(summary),nextCursor:offset+limit<sorted.length?String(offset+limit):null};
    }
    if (action === 'getUserHistory') {
      const user = data.users.find(u=>u.id === payload.userId);
      if (!user) throw failure('NOT_FOUND','找不到这个用户');
      const games = data.games.filter(g=>g.status==='finished' && g.playerIds.includes(user.id));
      return {user:clone(user),stats:userStats(user.id,games),games:games.map(summary)};
    }
    if (action === 'importLegacy') {
      const added = [];
      for (const user of legacyForImport.users) if (!data.users.some(u=>u.id===user.id)) data.users.push(user);
      for (const game of legacyForImport.games) if (!data.games.some(g=>g.id===game.id)) {data.games.push(game);added.push(game);saveGameKey(game.id,legacyForImport.keys[game.id]);}
      persist();
      return {games:added.map(expose),users:clone(data.users),writeKeys:Object.fromEntries(added.map(g=>[g.id,legacyForImport.keys[g.id]])),alreadyImported:!added.length};
    }
    if (action === 'createGame') {
      if (!Array.isArray(payload.playerIds) || payload.playerIds.length !== 5 || new Set(payload.playerIds).size !== 5) throw failure('VALIDATION','请选择 5 位不同的用户');
      const players = payload.playerIds.map(id=>data.users.find(u=>u.id===id)?.name);
      validatePlayers(players);
      const title = String(payload.title || '五人牌局').trim();
      if (!title || [...title].length>40 || /[\u0000-\u001f\u007f]/u.test(title)) throw failure('VALIDATION','牌局名称须为 1～40 个可见字符');
      const now = new Date().toISOString();
      const game = {...createGame({players,mainDealer:payload.mainDealer},{id:newGameId,now}),playerIds:[...payload.playerIds],title,version:0,kind:'game',updatedAt:now,writeKeyHash:newWriteHash};
      data.games.push(game);persist();saveGameKey(game.id,newWriteKey);return {game:expose(game),writeKey:newWriteKey};
    }
    const index = data.games.findIndex(g=>g.id===payload.gameId);
    if (index<0) throw failure('NOT_FOUND','找不到这场牌局');
    const game = data.games[index];
    if (action==='getGame') return {game:expose(game)};
    if (!keyHash || keyHash!==game.writeKeyHash) throw failure('UNAUTHORIZED','此操作需要本场牌局的管理密钥');
    if (action==='verifyGameManager') return {game:expose(game)};
    if (expectedVersion!==game.version) throw failure('STALE_VERSION','记录已经更新，请刷新后重新确认本局分数');
    const now = new Date().toISOString();
    let updated;
    if (action==='addRound') {
      if (game.rounds.length>=500) throw failure('ROUND_LIMIT','本场已达 500 局，请结束后新开一场');
      updated=applyRound(game,payload,{id:randomHex(),now});
    } else if (action==='undoRound') updated=undoLastRound(game);
    else if (action==='finishGame') updated=finishGame(game,now);
    else throw failure('VALIDATION','未知操作');
    updated.version=game.version+1;updated.updatedAt=now;
    if (new TextEncoder().encode(JSON.stringify(updated)).length>900000) throw failure('GAME_FULL','本场记录过多，请先导出并结束牌局');
    data.games[index]=updated;persist();return {game:expose(updated)};
  };
  if (navigator.locks) return navigator.locks.request('five-card-v2-data',async()=>execute());
  return execute();
}
let sdkPromise, loginPromise;
function signIn(app) {
  if (!loginPromise) loginPromise = app.auth().signInAnonymously().finally(() => { loginPromise = undefined; });
  return loginPromise;
}
function isLoginFailure(error) {
  if (error?.code === 'LOGIN_TYPE_DISABLED') return false;
  return /login|auth|credential|token|登录|身份/i.test(`${error?.code || ''} ${error?.message || error?.errMsg || error || ''}`);
}
function loadCloud() {
  if (!sdkPromise) sdkPromise = new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src=config.sdkUrl || 'https://static.cloudbase.net/cloudbase-js-sdk/2.17.3/cloudbase.full.js';
    script.onload=resolve;script.onerror=()=>reject(new Error('云端组件加载失败，请检查网络后刷新。'));
    document.head.append(script);
  }).then(async()=>{
    if (!window.cloudbase) throw new Error('云端组件未就绪');
    const app=window.cloudbase.init({env:config.envId,region:config.region || 'ap-shanghai'});
    const auth=app.auth();
    let loggedIn;
    try { loggedIn=await auth.getLoginState(); }
    catch (error) { if (!isLoginFailure(error)) throw error; }
    if (!loggedIn) await signIn(app);
    return app;
  }).catch(error=>{sdkPromise=undefined;throw error;});
  return sdkPromise;
}
export async function api(action,payload={},expectedVersion) {
  if (mode()==='local') return localRequest(action,payload,expectedVersion);
  try {
  const app=await loadCloud();
  const request=action==='getLegacyRoom' ? {action:'getRoom',...(legacySession() || {})} : {apiVersion:2,action,payload,gameId:payload.gameId,writeKey:gameKey(payload.gameId),expectedVersion};
  let response;
  try { response=await app.callFunction({name:config.functionName || 'scorekeeper',data:request}); }
  catch (error) {
    // Only a rejected identity check is retried. Business failures and uncertain
    // write outcomes must never trigger an automatic second submission.
    if (!isLoginFailure(error)) throw error;
    await signIn(app);
    response=await app.callFunction({name:config.functionName || 'scorekeeper',data:request});
  }
  const output=typeof response.result==='string'?JSON.parse(response.result):response.result;
  if (output?.error) throw failure(output.error.code,output.error.message || '云端操作失败');
  if (!output || typeof output!=='object') throw new Error('云端响应不完整，请刷新重试');
  if (action==='createGame' && output.game && output.writeKey) saveGameKey(output.game.id,output.writeKey);
  if (action==='importLegacy') for (const [id,key] of Object.entries(output.writeKeys || {})) saveGameKey(id,key);
  return output;
  } catch (error) { throw cloudFailure(error); }
}

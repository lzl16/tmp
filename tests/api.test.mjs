import test from 'node:test';
import assert from 'node:assert/strict';
const data = new Map();
const listeners = new Map();
globalThis.window={SCOREKEEPER_CONFIG:{envId:''},addEventListener:(name,callback)=>listeners.set(name,callback)};
globalThis.localStorage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};
globalThis.location={hash:'',pathname:'/',search:''};
const {api,mode,gameKey,saveGameKey} = await import('../public/api.mjs');

async function createUsers(prefix) {
  const users=[];
  for(const suffix of ['甲','乙','丙','丁','戊']) users.push((await api('createUser',{name:prefix+suffix})).user);
  return users;
}
test('v2 local lifecycle associates profiles, secures game, and aggregates completed history',async()=>{
  assert.equal(mode(),'local');
  const users=await createUsers('朋友');
  await assert.rejects(api('createUser',{name:'朋友甲'}),/昵称已经存在/);
  let {game}=await api('createGame',{title:'验收牌局',playerIds:users.map(u=>u.id),mainDealer:0});
  const key=gameKey(game.id);
  assert.ok(key);
  assert.equal(game.version,0);
  assert.equal((await api('listGames')).games[0].rounds,undefined);
  const oldVersion=game.version;
  ({game}=await api('addRound',{gameId:game.id,viceDealer:2,score:0},game.version));
  assert.deepEqual(game.levels,['6','2','6','2','2']);
  assert.equal(game.mainDealer,2);
  const main=game.statistics.find(row=>row.userId===users[2].id);
  assert.equal(main.rank,1);assert.equal(main.mainDealerBonus,0.5);
  assert.equal(game.statistics.find(row=>row.userId===users[0].id).rank,2);
  await assert.rejects(api('addRound',{gameId:game.id,viceDealer:1,score:120},oldVersion),/刷新/);
  saveGameKey(game.id,null);
  assert.equal((await api('getGame',{gameId:game.id})).game.roundCount,1);
  await assert.rejects(api('finishGame',{gameId:game.id},game.version),/管理密钥/);
  saveGameKey(game.id,'wrong');
  await assert.rejects(api('verifyGameManager',{gameId:game.id}),/管理密钥/);
  saveGameKey(game.id,key);
  assert.equal((await api('verifyGameManager',{gameId:game.id})).game.id,game.id);
  assert.equal((await api('getUserHistory',{userId:users[2].id})).stats.completedGames,0);
  ({game}=await api('finishGame',{gameId:game.id},game.version));
  const {stats}=await api('getUserHistory',{userId:users[2].id});
  assert.equal(stats.completedGames,1);assert.equal(stats.averageRank,1);
  assert.equal(stats.dealerRounds,1);assert.equal(stats.dealerAverage,0);assert.equal(stats.idleAverage,null);
  assert.ok(!JSON.stringify(game).includes(key));
});

test('independent active games can coexist; undo updates cumulative stats and histories list all games',async()=>{
  const users=await createUsers('另一组');
  let {game}=await api('createGame',{playerIds:users.map(u=>u.id),mainDealer:4});
  const second=(await api('createGame',{playerIds:users.map(u=>u.id),mainDealer:0})).game;
  assert.notEqual(game.id,second.id);
  ({game}=await api('addRound',{gameId:game.id,viceDealer:0,score:160},game.version));
  assert.equal(game.statistics.find(row=>row.seat===1).totalUpgrade,1);
  ({game}=await api('undoRound',{gameId:game.id},game.version));
  assert.equal(game.roundCount,0);assert.equal(game.mainDealer,4);
  assert.ok(game.statistics.every(row=>row.totalUpgrade===0&&row.rank===null));
  let cursor=null,all=[];
  do {const page=await api('listGames',{limit:1,cursor});all.push(...page.games);cursor=page.nextCursor;}while(cursor);
  assert.ok(all.length>=3);
});

import { api, mode, gameKey, saveGameKey, legacySession } from './api.mjs';
import { LEVELS, applyRound } from './rules.mjs';
import { gameStats } from './stats.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
  table:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 9h4v6H7zM15 9h2M15 12h2M15 15h2"/>',
  history:'<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .2c0 1.8-2.5 2-2.5 3.8M12 17h.01"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  share:'<path d="M12 16V3m-4 4 4-4 4 4M5 12v8h14v-8"/>',
  settings:'<path d="m9 3-.6 2.4-2 .9-2.2-.7-2 3.4L4 10.6v2.8L2.2 15l2 3.4 2.2-.7 2 .9L9 21h4l.6-2.4 2-.9 2.2.7 2-3.4-1.8-1.6v-2.8l1.8-1.6-2-3.4-2.2.7-2-.9L13 3z"/><circle cx="11" cy="12" r="3"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  refresh:'<path d="M20 8a8 8 0 0 0-14-2L3 9m0-6v6h6M4 16a8 8 0 0 0 14 2l3-3m0 6v-6h-6"/>',
  undo:'<path d="M4 10h10a6 6 0 0 1 0 12M4 10l6-6M4 10l6 6"/>',
  finish:'<path d="M5 21V3m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
  link:'<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
};
const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.table}</svg>`;
const brandIcon = `<svg class="brand-icon" viewBox="0 0 40 46" fill="none" aria-hidden="true"><rect x="7" y="3" width="29" height="38" rx="4" transform="rotate(8 7 3)" stroke="currentColor" stroke-width="1.4"/><rect x="3" y="5" width="28" height="37" rx="4" fill="currentColor"/><path d="M17 15c-3-5-8 0-4 3-7 0-6 8-1 7 1 0 2-1 3-2l-1 6h6l-1-6c4 5 10 0 7-3-1-2-3-2-5-2 4-4-1-8-4-3z" fill="#173f35"/></svg>`;
icons.users = '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5.7"/>';
icons.trophy = '<path d="M8 3h8v5a4 4 0 0 1-8 0V3ZM8 5H4v2a4 4 0 0 0 4 4M16 5h4v2a4 4 0 0 1-4 4M12 12v6M8 21h8M9 18h6"/>';
const state = {
  page: 'score', gameId: null, userId: null, game: null, userHistory: null,
  users: [], games: [], nextCursor: null, loading: true, error: null, busy: false,
  draftRound: null, viceDealer: null, mainDealer: null, wrongPlayer: null, resultType: 'score', score: '', allRounds: false, historyFilter: 'all',
  userSearch: '', newGameDraft: null, modalType: null, inlineSeat: null, legacyRoom: null,
};
let toastTimer, routeRevision = 0;
const writer = () => Boolean(state.game && gameKey(state.game.id));
const countRounds = game => game.rounds?.length ?? game.roundCount ?? 0;
const title = game => game.title || `${date(game.createdAt)}牌局`;
const date = (value, full = false) => {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric', ...(full ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d);
};
const metric = (value, places = 1) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: places, minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : places });
const playerName = (game, seat) => seat === null ? '待手动指定' : game.players?.[seat] ?? '未知玩家';
const statsFor = game => game.statistics || gameStats(game);
const rankLabel = rank => rank ? `第 ${rank} 名` : '—';
function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 3600);
}
function setBusy(value) {
  state.busy = value;
  document.querySelectorAll('[data-mutate]').forEach(el => {
    if (value) { if (!el.hasAttribute('data-pre-busy')) el.dataset.preBusy = String(el.disabled); el.disabled = true; }
    else if (el.hasAttribute('data-pre-busy')) { el.disabled = el.dataset.preBusy === 'true'; delete el.dataset.preBusy; }
  });
}
function showError(error) {
  const msg = ['STALE_VERSION', 'CONFLICT'].includes(error.code) ? '记录已在其他设备更新。请刷新后核对本局分数，再重新提交。' : error.message || '操作未完成，请重试';
  const el = $('#modal .form-error');
  if (el && $('#modal').open) el.textContent = msg; else toast(msg, true);
}
function syncGame(game) {
  if (game.id === state.gameId) state.game = game;
  const index = state.games.findIndex(g => g.id === game.id);
  const summary = { ...game, roundCount: countRounds(game) }; delete summary.rounds;
  if (index < 0) state.games.unshift(summary); else state.games[index] = summary;
}
async function request(action, payload = {}, onSuccess, expectedVersion) {
  if (state.busy) return null;
  setBusy(true);
  try {
    const result = await api(action, payload, expectedVersion);
    if (result.game) syncGame(result.game);
    if (onSuccess) await onSuccess(result);
    return result;
  } catch (error) { showError(error); return null; }
  finally { setBusy(false); updatePreview(); }
}
function navigate(hash = '') {
  closeModal(true);
  if (location.hash === hash || (!hash && !location.hash)) route(); else location.hash = hash;
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function gameRoute(id) { return `#game=${encodeURIComponent(id)}`; }
function userRoute(id) { return `#user=${encodeURIComponent(id)}`; }
function currentRoute() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('game')) return { page: 'score', gameId: params.get('game'), userId: null };
  if (params.get('user')) return { page: 'users', gameId: null, userId: params.get('user') };
  if (location.hash === '#history') return { page: 'history', gameId: null, userId: null };
  if (location.hash === '#users') return { page: 'users', gameId: null, userId: null };
  if (location.hash === '#help') return { page: 'help', gameId: null, userId: null };
  return { page: 'score', gameId: null, userId: null };
}
async function loadGameIndex() {
  const games = [], seen = new Set(), cursors = new Set();
  let cursor = null;
  do {
    const page = await api('listGames', { limit: 100, ...(cursor ? { cursor } : {}) });
    for (const game of page.games || []) if (!seen.has(game.id)) { games.push(game); seen.add(game.id); }
    cursor = page.nextCursor || null;
    if (cursor && cursors.has(cursor)) break;
    if (cursor) cursors.add(cursor);
  } while (cursor && games.length < 1000);
  return { games, nextCursor: cursor };
}
async function route(quiet = false) {
  const revision = ++routeRevision;
  const previousGameId = state.gameId;
  Object.assign(state, currentRoute());
  if (previousGameId !== state.gameId) { state.game = null; state.allRounds = false; }
  state.error = null;
  if (state.page === 'help') { state.loading = false; render(); return; }
  if (!quiet) { state.loading = true; render(); }
  try {
    const [users, games, detail] = await Promise.all([
      api('listUsers'), loadGameIndex(),
      state.gameId ? api('getGame', { gameId: state.gameId }) : state.userId ? api('getUserHistory', { userId: state.userId }) : Promise.resolve(null),
    ]);
    if (revision !== routeRevision) return;
    state.users = users.users || []; state.games = games.games || []; state.nextCursor = games.nextCursor || null;
    if (state.gameId) syncGame(detail.game);
    if (state.userId) state.userHistory = detail;
    state.loading = false; render(); if (quiet) toast('记录已更新');
  } catch (error) {
    if (revision !== routeRevision) return;
    state.loading = false;
    state.error = error.message || '无法读取记录，请重试';
    if (quiet) showError(error);
    render();
  }
}
function nav() {
  const items = [['score', 'table', '记分台', ''], ['history', 'history', '历史牌局', '#history'], ['users', 'users', '用户成绩', '#users'], ['help', 'help', '规则说明', '#help']];
  return `<aside class="sidebar"><div class="brand">${brandIcon}<div><div class="brand-title">五人牌局</div><div class="brand-subtitle">THE CARD JOURNAL</div></div></div><nav class="navigation" aria-label="主导航">${items.map(([id, i, label, hash]) => `<button class="nav-item ${state.page === id ? 'active' : ''}" data-action="nav" data-hash="${hash}" ${state.page === id ? 'aria-current="page"' : ''}>${icon(i)}<span>${label}</span></button>`).join('')}</nav><div class="sidebar-bottom"><div class="sidebar-caption">好友相聚，分数有据</div><div class="sidebar-room">每一场，都值得记录</div><span class="sidebar-small">${state.users.length} 位玩家 · ${state.games.length}${state.nextCursor ? '+' : ''} 场牌局</span><div class="sidebar-ornament">♠ ♡ ♣ ♢</div></div></aside>`;
}
function topbar() {
  return `<header class="topbar"><div class="breadcrumb">牌局记分簿 <span>/</span><strong>${{ score: state.gameId ? '牌局详情' : '记分台', history: '历史牌局', users: '用户成绩', help: '规则说明' }[state.page]}</strong></div><div class="mobile-brand">${brandIcon}<span>五人牌局</span></div><div class="top-actions"><span class="mode-badge ${mode() === 'local' ? 'local' : ''}"><i class="status-dot"></i>${mode() === 'local' ? '本机体验' : '云端记分'}</span>${state.game ? `<button class="text-button" data-action="share">${icon('share')}<span>分享</span></button><button class="icon-button" data-action="settings" aria-label="本场管理">${icon('settings')}</button>` : `<button class="icon-button" data-action="refresh" aria-label="刷新记录">${icon('refresh')}</button>`}</div></header>`;
}
function localBanner() {
  return mode() === 'local' ? `<div class="preview-banner"><div>${icon('info')}<strong>本机体验：记录仅保存在当前浏览器，其他手机暂不能同步。</strong></div></div>` : '';
}
function render() {
  const key = state.game ? `${state.game.id}:${state.game.version}:${state.game.rounds?.at(-1)?.id || 'empty'}:${state.game.mainDealer}` : null;
  if (key !== state.draftRound) { state.draftRound = key; state.viceDealer = null; state.mainDealer = null; state.wrongPlayer = null; state.resultType = 'score'; state.score = ''; }
  const content = state.loading ? `<div class="loading-panel"><div class="spin"></div><p>正在读取牌局记录…</p></div>` : state.error ? errorPage() : state.page === 'help' ? helpPage() : state.gameId ? gamePage() : state.page === 'history' ? historyPage() : state.page === 'users' ? usersPage() : homePage();
  $('#app').innerHTML = `<div class="app-shell">${nav()}<main class="main">${topbar()}${localBanner()}${content}</main></div>`;
  setBusy(state.busy); updatePreview();
}
function errorPage() {
  return `<section class="panel error-panel"><div class="eyebrow">CONNECTION</div><h2>暂时无法读取记录</h2><p>${esc(state.error)}</p><div class="error-actions"><button class="button primary" data-action="refresh">${icon('refresh')}重新读取</button><button class="button secondary" data-action="nav" data-hash="">返回记分台</button></div></section>`;
}
function gameCard(game, compact = false) {
  return `<button class="game-card ${compact ? 'compact' : ''}" data-action="open-game" data-id="${esc(game.id)}"><div class="game-card-top"><span class="badge ${game.status === 'active' ? '' : 'neutral'}">${game.status === 'active' ? '进行中' : '已结束'}</span><span class="small-muted">${countRounds(game)} 局</span></div><h3>${esc(title(game))}</h3><div class="game-card-date">${date(game.createdAt, true)}</div><div class="game-card-players">${game.players?.map(n => `<span>${esc(n)}</span>`).join('') || ''}</div><div class="game-card-bottom"><span>${game.status === 'active' ? `当前主庄 · ${esc(playerName(game, game.mainDealer))}` : '查看结算与每局明细'}</span>${icon('arrow')}</div></button>`;
}
function legacyBanner() {
  let legacy; try { legacy = legacySession(); } catch { return ''; }
  return legacy?.roomId ? `<div class="legacy-note">${icon('history')}<div>这台设备上有旧版记录，可查看或导入到新版历史。</div><button class="text-button" data-action="legacy">旧版记录 ${icon('arrow')}</button></div>` : '';
}
function homePage() {
  const active = state.games.filter(g => g.status === 'active'), recent = state.games.filter(g => g.status !== 'active').slice(0, 3);
  return `<div class="page-heading"><div><div class="eyebrow">FIVE FRIENDS. A GOOD HAND.</div><h1>今天，打到几？</h1><p>每场从 2 开始，升级、轮庄和成绩自动记好。</p></div><button class="button primary" data-action="new-game">${icon('plus')}新建牌局</button></div>${legacyBanner()}${active.length ? `<div class="section-heading"><h2>正在进行</h2><span class="caption">${active.length} 场</span></div><div class="games-grid">${active.map(g => gameCard(g)).join('')}</div>` : `<section class="start-panel panel"><div class="start-icon">♣</div><div><h2>五位朋友，随时开场。</h2><p>选择玩家和首局主庄，剩下的交给记分簿。</p></div><button class="button primary" data-action="new-game">${icon('plus')}开始一场新牌局</button></section>`}<div class="section-heading"><h2>最近结束的牌局</h2><button class="text-button" data-action="nav" data-hash="#history">全部历史 ${icon('arrow')}</button></div>${recent.length ? `<div class="games-grid">${recent.map(g => gameCard(g, true)).join('')}</div>` : `<section class="panel"><div class="empty-inner compact-empty"><div class="empty-icon">${icon('history')}</div><h3>第一场的故事，等你写下。</h3><p>结束牌局后，在这里回看成绩与每局分数。</p></div></section>`}<div class="home-foot"><span>${icon('users')}昵称档案可重复选用，成绩持续累计。</span><button class="text-button" data-action="nav" data-hash="#users">查看用户成绩 ${icon('arrow')}</button></div>`;
}
function historyPage() {
  const games = state.games.filter(g => state.historyFilter === 'all' || g.status === state.historyFilter);
  return `<div class="page-heading"><div><div class="eyebrow">THE PAST HANDS</div><h1>历史牌局</h1><p>所有牌局，随时回看每局分数和最终成绩。</p></div><button class="button primary small" data-action="new-game">${icon('plus')}新建牌局</button></div><div class="filter-bar" aria-label="筛选牌局">${[['all', '全部牌局'], ['finished', '已结束'], ['active', '进行中']].map(([id, label]) => `<button class="filter-chip ${state.historyFilter === id ? 'selected' : ''}" data-action="history-filter" data-filter="${id}">${label}</button>`).join('')}<span class="small-muted">已加载 ${state.games.length} 场</span></div>${games.length ? `<div class="games-grid history-games">${games.map(g => gameCard(g)).join('')}</div>` : `<section class="panel"><div class="empty-inner"><div class="empty-icon">${icon('history')}</div><h3>还没有${state.historyFilter === 'finished' ? '已结束的' : state.historyFilter === 'active' ? '进行中的' : ''}牌局</h3><p>新建牌局后，记录就会显示在这里。</p></div></section>`}${state.nextCursor ? `<div class="load-more"><button class="button secondary" data-action="more-games" data-mutate>加载更多牌局</button></div>` : ''}`;
}
function preview() {
  const game = state.game;
  if (!game || game.status !== 'active') return null;
  if (state.resultType === 'score' && (state.score.trim() === '' || state.viceDealer === null)) return null;
  try {
    const payload = state.resultType === 'wrong'
      ? { type: 'wrong', wrongPlayer: state.wrongPlayer }
      : { type: 'score', mainDealer: game.mainDealer === null ? state.mainDealer : game.mainDealer, viceDealer: state.viceDealer, score: Number(state.score) };
    return applyRound(game, payload, { id: 'preview', now: 'preview' }).rounds.at(-1);
  } catch { return null; }
}
function outcome(round) {
  if (round.type === 'wrong') return '错牌玩家不升级，其余 4 人各升 1 级';
  if (round.dealerUpgrade) return `主庄、副庄各升 ${round.dealerUpgrade} 级`;
  if (round.idleUpgrade) return `闲家各升 ${round.idleUpgrade} 级`;
  return '双方均不升级';
}
function previewHtml() {
  const p = preview();
  const hint = state.resultType === 'wrong' ? '选择错牌玩家后，自动计算结果。' : state.game?.mainDealer === null ? '手动选择本局主庄、副庄并填写得分。' : '选择副庄并填写得分后，自动计算结果。';
  return `<div class="settlement-heading">本局结算预览</div>${p ? `<div class="settlement-line"><strong>${outcome(p)}</strong><span class="badge ${p.type === 'wrong' || p.dealerUpgrade ? 'gold' : ''}">${p.type === 'wrong' ? esc(playerName(state.game, p.wrongPlayer)) + '错牌' : p.score + ' 分'}</span></div><div class="settlement-next">${p.type === 'wrong' ? '下一局主庄、副庄需在记录得分时手动选择。' : `下一局主庄 · <strong>${esc(playerName(state.game, p.nextMainDealer))}</strong><span>（${p.nextMainDealer + 1} 号位）</span>`}</div>` : `<div class="placeholder">${hint}</div>`}`;
}
function updatePreview() {
  const el = $('#settlement'); if (el) el.innerHTML = previewHtml();
  const save = $('#save-round'); if (save) save.disabled = state.busy || !preview();
}
function levelCards(game) {
  const stats = statsFor(game);
  return `<div class="board-top"><h2>${game.status === 'active' ? '当前等级' : '最终等级'}</h2><span class="caption">等级 2 → A 循环 · 升级数持续累计</span></div><div class="level-grid">${game.players.map((name, i) => `<div class="level-card ${i === game.mainDealer ? 'main-dealer' : ''}"><div class="seat-label">SEAT 0${i + 1}</div><button class="player-name player-link" data-action="open-user" data-id="${esc(game.playerIds?.[i] || '')}" ${!game.playerIds?.[i] ? 'disabled' : ''} title="查看 ${esc(name)} 的成绩">${esc(name)}</button><div class="level-value">${esc(game.levels[i])}<span class="level-value-label">当前等级</span></div><div class="upgrade-caption">累计升 <strong>${metric(stats.find(r => r.seat === i)?.totalUpgrade ?? 0, 0)}</strong> 级</div>${i === game.mainDealer ? `<span class="level-role">${game.status === 'active' ? '主庄' : '结束主庄'}</span>` : ''}</div>`).join('')}</div>`;
}
function gamePage() {
  const game = state.game;
  if (!game) return errorPage();
  const finished = game.status === 'finished', rounds = game.rounds || [];
  return `<button class="text-button back-button" data-action="nav" data-hash="${finished ? '#history' : ''}">← ${finished ? '返回历史牌局' : '返回记分台'}</button><div class="page-heading game-heading"><div><div class="eyebrow">${finished ? 'A GOOD GAME, WELL REMEMBERED' : 'LET’S PLAY A GOOD HAND'}</div><h1>${esc(title(game))}</h1><p>${date(game.createdAt, true)} 开始${finished ? ` · ${date(game.finishedAt, true)} 结束` : ` · 按座位顺序轮转`}</p></div><span class="badge ${finished ? 'neutral' : ''}">${finished ? '已结束' : '进行中'} · ${rounds.length} 局</span></div>${levelCards(game)}${finished ? completedStats(game) : `${!writer() ? `<div class="readonly-note">${icon('eye')}<div><strong>正在查看本场记录</strong><p>记分人保存后，刷新即可看到最新一局。</p></div><button class="text-button" data-action="restore-key">恢复记分权限</button></div>` : ''}<div class="game-columns">${writer() ? scoreForm(game) : readonlyGame(game)}<section class="panel round-list-panel"><div class="panel-head"><h2 class="section-label">本场记录</h2><span class="caption">已完成 ${rounds.length} 局</span></div>${rounds.length ? `<div class="round-list">${[...rounds].reverse().slice(0, state.allRounds ? undefined : 4).map(r => roundEntry(r, game, state.allRounds)).join('')}</div>${rounds.length > 4 || state.allRounds ? `<div class="round-list-footer"><button class="text-button" data-action="toggle-rounds">${state.allRounds ? '收起明细' : `查看全部 ${rounds.length} 局明细`} ${icon('arrow')}</button></div>` : ''}` : `<div class="round-list-empty">第一局的故事，等你写下。<br><span class="small-muted">保存后会自动显示在这里。</span></div>`}</section></div><div class="game-tools">${writer() ? `<button class="text-button" data-action="undo" data-mutate ${!rounds.length ? 'disabled' : ''}>${icon('undo')}撤销上一局</button><button class="text-button" data-action="finish" data-mutate>${icon('finish')}结束本场牌局</button>` : `<button class="text-button" data-action="refresh">${icon('refresh')}刷新记录</button>`}</div>`}<footer class="table-footer"><span>${finished ? '累计升级数决定名次；结束主庄在同级时领先半级。' : '每次保存后，等级与下一局主庄自动更新。'}</span><span class="suits">♠ ♡ ♣ ♢</span></footer>`;
}
function scoreForm(game) {
  const manual = game.mainDealer === null, main = manual ? state.mainDealer : game.mainDealer;
  const options = selected => `<option value="">请选择玩家</option>${game.players.map((name, i) => `<option value="${i}" ${selected === i ? 'selected' : ''}>${i + 1} 号位 ${esc(name)}</option>`).join('')}`;
  return `<section class="panel score-panel"><div class="panel-head"><h2 class="section-label">记录第 ${countRounds(game) + 1} 局</h2><span class="badge">进行中</span></div><div class="round-current"><span class="round-symbol">♣</span><div><div class="caption">${manual ? '上一局出现错牌' : '本局主庄'}</div><strong>${manual ? '本局主庄、副庄需手动指定' : esc(playerName(game, game.mainDealer)) + ` <span class="small-muted">· ${game.mainDealer + 1} 号位</span>`}</strong></div></div><form id="round-form" class="score-form"><div class="field"><label>本局结果</label><div class="result-options" role="group" aria-label="本局结果">${[['score', '正常得分'], ['wrong', '错牌']].map(([value, label]) => `<button type="button" class="vice-option ${state.resultType === value ? 'selected' : ''}" aria-pressed="${state.resultType === value}" data-action="result-type" data-type="${value}" data-mutate>${label}</button>`).join('')}</div></div>${state.resultType === 'wrong' ? `<div class="field"><label for="wrong-player">谁出现了错牌？</label><select id="wrong-player" required data-mutate>${options(state.wrongPlayer)}</select><p class="field-help">该玩家不升级，其余 4 人各升 1 级；本局不计角色局数及均分。</p></div>` : `${manual ? `<div class="field"><label for="main-dealer">本局主庄</label><select id="main-dealer" required data-mutate>${options(state.mainDealer)}</select></div>` : ''}<div class="field"><label>谁是本局副庄？</label><div class="vice-options">${game.players.map((name, i) => i === main ? '' : `<button type="button" class="vice-option ${state.viceDealer === i ? 'selected' : ''}" aria-pressed="${state.viceDealer === i}" data-action="vice" data-seat="${i}" data-mutate ${manual && main === null ? 'disabled' : ''}><span class="seat">${i + 1} 号位</span>${esc(name)}</button>`).join('')}</div>${manual && main === null ? '<p class="field-help">请先选择主庄，再选择另一位玩家作为副庄。</p>' : ''}</div><div class="field"><label for="idle-score">闲家合计得分 <span class="label-hint">· 其余 3 人</span></label><div class="score-input-wrap"><input id="idle-score" name="score" type="number" min="0" step="1" inputmode="numeric" autocomplete="off" placeholder="输入分数" value="${esc(state.score)}" required data-mutate><span>分</span></div><p class="field-help">填写 3 位闲家的合计分数，0 分也可记录。</p></div>`}<div class="settlement" id="settlement" aria-live="polite">${previewHtml()}</div><button id="save-round" class="button primary full" type="submit" data-mutate disabled>保存并开始下一局 ${icon('arrow')}</button><p class="save-help">保存后可撤销上一局，重新填写。</p></form></section>`;
}
function readonlyGame(game) {
  return `<section class="panel"><div class="panel-head"><h2 class="section-label">等待第 ${countRounds(game) + 1} 局</h2><span class="badge">进行中</span></div><div class="round-current"><span class="round-symbol">♣</span><div><div class="caption">本局主庄</div><strong>${esc(playerName(game, game.mainDealer))}</strong></div></div><div class="empty-inner"><div class="empty-icon">${icon('eye')}</div><h3>好牌正在路上</h3><p>记分人保存后，在这里刷新查看结果。</p><button class="button secondary" data-action="refresh">${icon('refresh')}刷新记录</button></div></section>`;
}
function roundEntry(round, game, detailed = false) {
  if (round.type === 'wrong') return `<article class="round-entry wrong-round"><div class="round-row"><span class="round-number">第 ${round.number} 局 <span class="round-date">${date(round.createdAt, true)}</span></span><span class="badge gold">错牌</span></div><div class="round-detail">错牌玩家：${esc(playerName(game, round.wrongPlayer))}</div><div class="round-result">${outcome(round)}</div><div class="small-muted">下一局主庄、副庄手动指定；本局不计角色局数与均分。</div>${detailed ? `<div class="history-levels">${game.players.map((name, i) => `<span>${esc(name)} <strong>${esc(round.levelsBefore?.[i])} → ${esc(round.levelsAfter?.[i])}</strong></span>`).join('')}</div>` : ''}</article>`;
  return `<article class="round-entry"><div class="round-row"><span class="round-number">第 ${round.number} 局 <span class="round-date">${date(round.createdAt, true)}</span></span><div class="round-score">${round.score}<small>分</small></div></div><div class="round-detail"><span>主庄 ${esc(playerName(game, round.mainDealer))}</span><span class="dot">·</span><span>副庄 ${esc(playerName(game, round.viceDealer))}</span></div><div class="round-result">${outcome(round)}${detailed ? `<span class="small-muted"> · 下局主庄 ${esc(playerName(game, round.nextMainDealer))}</span>` : ''}</div>${detailed ? `<div class="history-levels">${game.players.map((name, i) => `<span>${esc(name)} <strong>${esc(round.levelsBefore?.[i] || '2')} → ${esc(round.levelsAfter?.[i] || '2')}</strong></span>`).join('')}</div>` : ''}</article>`;
}
function completedStats(game) {
  const rounds = game.rounds || [], stats = statsFor(game).slice().sort((a, b) => a.rank - b.rank || a.seat - b.seat);
  return `<section class="panel result-panel"><div class="panel-head"><div><h2 class="section-label">本场结算</h2><p class="panel-subtitle">按累计升级排序；主庄、副庄、闲家分别统计。</p></div><button class="text-button" data-action="export">${icon('download')}导出</button></div>${rounds.length ? `<div class="stats-table-scroll"><table class="stats-table"><thead><tr><th>名次 / 玩家</th><th>累计升级</th><th>主庄局数</th><th>副庄局数</th><th>闲家局数</th><th>主庄平均被得分</th><th>副庄平均被得分</th><th>闲家平均得分</th></tr></thead><tbody>${stats.map(row => `<tr class="${row.rank === 1 ? 'first-place' : ''}"><th><div class="rank-name"><span class="rank-medal ${row.rank === 1 ? 'winner' : ''}">${row.rank}</span><button class="player-link" data-action="open-user" data-id="${esc(row.userId || '')}" ${!row.userId ? 'disabled' : ''}>${esc(row.name)}</button></div></th><td><strong>${metric(row.totalUpgrade, 0)}</strong> 级${row.mainDealerBonus ? '<span class="half-bonus" title="结束时为主庄，同级领先">+½</span>' : ''}</td><td>${row.mainDealerRounds}</td><td>${row.viceDealerRounds}</td><td>${row.idleRounds}</td><td>${metric(row.mainDealerAverage)}<small> 分</small></td><td>${metric(row.viceDealerAverage)}<small> 分</small></td><td>${metric(row.idleAverage)}<small> 分</small></td></tr>`).join('')}</tbody></table></div><div class="statistics-note">+½ 表示结束时为主庄，仅用于同级排名。并列名次采用 1、1、1、4 的排序；— 表示没有对应局数。</div>` : `<div class="empty-inner"><h3>本场没有记录有效局数</h3><p>空场不计入用户历史成绩与平均名次。</p></div>`}</section><section class="panel complete-rounds"><div class="panel-head"><h2 class="section-label">每局明细</h2><span class="caption">${rounds.length} 局</span></div>${rounds.length ? `<div class="round-list">${[...rounds].reverse().map(r => roundEntry(r, game, true)).join('')}</div>` : `<div class="round-list-empty">没有保存的分数记录。</div>`}</section>`;
}
function usersPage() {
  if (state.userId) return userDetailPage();
  return `<div class="page-heading"><div><div class="eyebrow">THE PEOPLE BEHIND THE CARDS</div><h1>用户成绩</h1><p>用固定昵称留下成绩，下次开场直接选择。</p></div><button class="button primary small" data-action="create-user">${icon('plus')}创建用户</button></div><div class="user-search"><label for="user-search" class="visually-hidden">搜索玩家昵称</label><input id="user-search" type="search" placeholder="搜索玩家昵称" value="${esc(state.userSearch)}" autocomplete="off"><span>${state.users.length} 位玩家</span></div><div id="user-list">${userListHtml()}</div>`;
}
function userListHtml() {
  const search = state.userSearch.trim().toLocaleLowerCase(), users = state.users.filter(user => user.name.toLocaleLowerCase().includes(search));
  return users.length ? `<div class="users-grid">${users.map(user => `<button class="user-card" data-action="open-user" data-id="${esc(user.id)}"><span class="avatar">${esc([...user.name][0])}</span><div><h3>${esc(user.name)}</h3><p>查看历史成绩与参赛牌局</p></div>${icon('arrow')}</button>`).join('')}</div>` : `<section class="panel"><div class="empty-inner"><div class="empty-icon">${icon('users')}</div><h3>${search ? '没有找到这位玩家' : '先认识一下，未来的牌友。'}</h3><p>${search ? '可以换个昵称搜索，或创建一个新用户。' : '创建昵称档案后，每场成绩都会归到同一位玩家。'}</p><button class="button primary small" data-action="create-user">${icon('plus')}创建用户</button></div></section>`;
}
function statCard(label, value, unit = '', help = '') {
  return `<div class="career-stat"><div class="caption">${label}</div><div class="career-value">${value}<span>${unit}</span></div>${help ? `<div class="career-help">${help}</div>` : ''}</div>`;
}
function userDetailPage() {
  const data = state.userHistory;
  if (!data?.user) return `<section class="panel error-panel"><h2>没有找到这位玩家</h2><button class="text-button" data-action="nav" data-hash="#users">返回用户成绩</button></section>`;
  const { user, stats } = data, history = stats.history || [];
  const games = data.games || [];
  return `<button class="text-button back-button" data-action="nav" data-hash="#users">← 返回用户成绩</button><div class="page-heading"><div><div class="eyebrow">A PERSONAL CARD JOURNAL</div><h1>${esc(user.name)}的历史成绩</h1><p>统计已结束且至少记录 1 局的牌局，进行中的成绩不计入。</p></div><span class="profile-avatar">${esc([...user.name][0])}</span></div><div class="career-grid">${statCard('完成牌局', metric(stats.completedGames, 0), '场')}${statCard('平均牌局名次', metric(stats.averageRank, 2), '名')}${statCard('主庄场次总数', metric(stats.mainDealerRounds, 0), '局')}${statCard('副庄场次总数', metric(stats.viceDealerRounds, 0), '局')}${statCard('闲家场次总数', metric(stats.idleRounds, 0), '局')}${statCard('主庄所有场次平均被得分', metric(stats.mainDealerAverage), '分')}${statCard('副庄所有场次平均被得分', metric(stats.viceDealerAverage), '分')}${statCard('闲家所有场次平均得分', metric(stats.idleAverage), '分')}</div><div class="section-heading"><h2>历史牌局成绩</h2><span class="caption">共 ${stats.completedGames || 0} 场</span></div>${history.length || games.length ? `<section class="panel"><div class="user-history-list">${(history.length ? history : games.map(g => ({ gameId: g.id, title: title(g), createdAt: g.createdAt, ...(g.statistics?.find(r => r.userId === user.id) || {}) }))).map(row => `<button class="user-history-row" data-action="open-game" data-id="${esc(row.gameId)}"><div class="user-history-rank">${row.rank ? `<span>${row.rank}</span><small>名</small>` : '—'}</div><div class="user-history-info"><h3>${esc(row.title || `${date(row.createdAt)}牌局`)}</h3><p>${date(row.finishedAt || row.createdAt, true)} · 累计升 ${metric(row.totalUpgrade ?? 0, 0)} 级${row.mainDealerBonus ? ' · 主庄 +½' : ''}</p></div>${icon('arrow')}</button>`).join('')}</div></section>` : `<section class="panel"><div class="empty-inner"><div class="empty-icon">${icon('trophy')}</div><h3>好成绩，从第一场开始。</h3><p>本用户完成一场有效牌局后，成绩会自动汇总在这里。</p></div></section>`}<div class="statistics-note career-note">平均得分按全部对应局数加权计算；闲家得分采用该局 3 人合计得分。错牌局不计角色局数和均分；没有对应局数时显示 —。</div>`;
}
function helpPage() {
  return `<div class="page-heading"><div><div class="eyebrow">A FEW HOUSE RULES</div><h1>规则说明</h1><p>规则说清楚，牌局打得更尽兴。</p></div></div><div class="help-layout"><section class="panel help-panel"><h2 class="section-label">每局怎样记分</h2><p>选择 5 位固定昵称玩家，按约定方向确定座位顺序，并选择首局主庄。每场等级都从 2 开始。每局结束后选择副庄，填写其余 3 位闲家的合计分数，自动升级并计算下一局主庄。记错时可撤销上一局，恢复当局开始时的等级和主庄。</p></section><section class="panel help-panel"><h2 class="section-label">闲家合计得分与升级</h2><table class="rule-table"><thead><tr><th>闲家合计得分</th><th>主庄、副庄</th><th>3 位闲家</th></tr></thead><tbody>${[['0 分', '各升 4 级', '不升级'], ['1～39 分', '各升 3 级', '不升级'], ['40～79 分', '各升 2 级', '不升级'], ['80～119 分', '各升 1 级', '不升级'], ['120～159 分', '不升级', '不升级'], ['160～199 分', '不升级', '各升 1 级'], ['200～239 分', '不升级', '各升 2 级']].map(row => `<tr>${row.map(x => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table><div class="help-note">160 分起，闲家每多得 40 分，各再升 1 级。0 分是特殊奖励，庄家各升 4 级。</div></section><section class="panel help-panel"><h2 class="section-label">出现错牌时</h2><p>将本局结果切换为“错牌”，选择一位错牌玩家。该玩家不升级，其余 4 人各升 1 级。下一局记录得分时，手动选择不同的主庄、副庄，之后恢复正常轮庄。连续出现错牌时，每局独立记录，继续等待手动指定。</p></section><section class="panel help-panel"><h2 class="section-label">等级与下一局主庄</h2><p>等级超过 A 后继续从 2 开始；累计升级数不会清零。</p><div class="rank-track">${LEVELS.map(r => `<span class="rank-chip">${r}</span>`).join('')}<span class="rank-chip">↻</span></div><p><strong>庄家升级时：</strong>本局副庄成为下一局主庄。<br><strong>庄家未升级时：</strong>从本局主庄的下一个座位开始，按座位顺序找到的第一位本局闲家成为下一局主庄。</p></section><section class="panel help-panel"><h2 class="section-label">本场名次与用户历史成绩</h2><p>名次按累计升级数量由高到低排序。结束时显示的主庄获得半级排名优势，累计升级仍按实际升级数记录；其他同级玩家并列。如果 3 人并列第一，下一位是第四名。主庄、副庄、闲家分别统计局数及平均分，均使用对应正常得分局的闲家合计分数。错牌局只计升级，不计角色局数和均分；若错牌后结束，下一局主庄未定，同升级数者并列。用户历史只统计已结束且至少保存 1 局的牌局；平均名次按完成牌局数计算，平均得分按全部对应局数加权计算。</p></section><section class="panel help-panel"><h2 class="section-label">查看、记分与备份</h2><p>${mode() === 'local' ? '当前为本机体验，记录只保存在当前浏览器，清除浏览器数据可能导致丢失。部署到云端后可多手机访问。' : '所有玩家可以从同一个网站查看牌局和用户成绩。昵称档案无需密码，本站访客可查看牌局及成绩。创建牌局的设备拥有本场记分权限，其他设备需要本场管理密钥才能记分。分享链接只包含牌局编号。'}</p><div class="help-note">请在“本场管理”中保存管理密钥，便于更换手机时恢复。导出 JSON 备份不含管理密钥。</div></section></div>`;
}
function openModal(titleText, subtitle, body, type = null) {
  const el = $('#modal'); state.modalType = type;
  el.innerHTML = `<div class="modal-head"><div><h2 id="modal-title">${esc(titleText)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><button type="button" class="close-button" data-action="close" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${body}</div>`;
  if (!el.open) el.showModal(); el.scrollTop = 0;
  queueMicrotask(() => $('#modal [autofocus]')?.focus());
}
function closeModal(force = false) {
  if (state.busy && !force) return;
  if (state.modalType === 'inline-user' && !force) { newGameDialog(true); return; }
  if ($('#modal').open) $('#modal').close(); state.modalType = null;
}
function rememberNewGameDraft() {
  const form = $('#new-game-form'); if (!form) return;
  const data = new FormData(form);
  state.newGameDraft = { title: String(data.get('title') || ''), playerIds: Array.from({ length: 5 }, (_, i) => String(data.get(`player${i}`) || '')), mainDealer: Number(data.get('mainDealer') || 0) };
}
function newGameDialog(preserve = false) {
  if (!preserve || !state.newGameDraft) {
    const last = state.games.find(g => g.playerIds?.length === 5 && g.playerIds.every(id => state.users.some(u => u.id === id)));
    state.newGameDraft = { title: '', playerIds: last ? [...last.playerIds] : Array(5).fill(''), mainDealer: 0 };
  }
  const draft = state.newGameDraft;
  openModal('开始一场新牌局', '按约定的轮转方向选择玩家，整场保持座位顺序。', `<form id="new-game-form"><div class="field"><label for="game-title">牌局名称 <span class="label-hint">· 可不填</span></label><input id="game-title" name="title" value="${esc(draft.title)}" maxlength="40" placeholder="例如：周末夜局" autocomplete="off"></div><div class="form-section-title">5 位玩家 <span class="label-hint">· 勾选首局主庄</span></div>${!state.users.length ? `<div class="muted-box new-users-hint">还没有用户。点击每个座位旁的“+”创建昵称档案，创建后自动选入。</div>` : ''}${Array.from({ length: 5 }, (_, i) => `<div class="seat-input v2-seat-input"><span class="seat-dot" aria-hidden="true">${i + 1}</span><label for="player-${i}" class="visually-hidden">${i + 1} 号位玩家</label><select id="player-${i}" name="player${i}" required data-seat="${i}"><option value="">选择已有用户</option>${state.users.map(user => `<option value="${esc(user.id)}" ${draft.playerIds[i] === user.id ? 'selected' : ''} ${draft.playerIds.includes(user.id) && draft.playerIds[i] !== user.id ? 'disabled' : ''}>${esc(user.name)}</option>`).join('')}</select><button type="button" class="add-seat-user" data-action="inline-user" data-seat="${i}" aria-label="为 ${i + 1} 号位创建用户" title="创建新用户">${icon('plus')}</button><label class="radio-main"><input name="mainDealer" type="radio" value="${i}" ${draft.mainDealer === i ? 'checked' : ''}>主庄</label></div>`).join('')}<div class="muted-box" style="margin-top:18px">5 人等级从 2 开始；主庄按 1 → 2 → 3 → 4 → 5 → 1 的座位顺序轮转。</div><div class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="button secondary" data-action="close">取消</button><button type="submit" class="button primary" data-mutate>开始牌局 ${icon('arrow')}</button></div></form>`, 'new-game');
}
function createUserDialog(seat = null) {
  if (seat !== null) rememberNewGameDraft();
  state.inlineSeat = seat;
  openModal('创建用户', '昵称档案可在以后每场重复选择，历史成绩会持续累计。', `<form id="create-user-form"><div class="field"><label for="user-name">玩家昵称</label><input id="user-name" name="name" maxlength="20" placeholder="输入独一无二的昵称" autocomplete="off" required autofocus></div><div class="muted-box">请用固定昵称。同名用户不能重复创建，已有用户可直接选择。</div><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button secondary" type="button" data-action="close">${seat !== null ? '返回选人' : '取消'}</button><button class="button primary" type="submit" data-mutate>创建${seat !== null ? '并选入' : '用户'}</button></div></form>`, seat !== null ? 'inline-user' : 'create-user');
}
function shareUrl() {
  const url = new URL(location.href); url.search = ''; url.hash = state.game ? gameRoute(state.game.id).slice(1) : ''; return url.href;
}
function shareDialog() {
  if (mode() === 'local') { openModal('当前为本机体验', '云端连接后，朋友即可用手机查看。', `<div class="muted-box">当前记录只保存在这个浏览器。可以先导出本场备份；本机体验链接无法让另一台手机同步记录。</div><div class="modal-actions"><button class="button secondary" data-action="export">${icon('download')}导出</button><button class="button primary" data-action="close">知道了</button></div>`); return; }
  openModal('分享这场牌局', '朋友打开链接即可查看分数与结算成绩。', `<div class="muted-box">链接不包含管理密钥。记分人保存后，朋友刷新页面即可看到最新记录。</div><div class="share-link"><label for="share-url" class="visually-hidden">查看链接</label><input id="share-url" readonly value="${esc(shareUrl())}"><button class="button primary small" data-action="copy-share">复制链接</button></div><div class="modal-actions"><button class="button secondary" data-action="close">完成</button></div>`);
}
function settingsDialog(reveal = false) {
  if (!state.game) return;
  openModal('本场管理', title(state.game), `<div class="settings-row"><div><h3>当前权限</h3><p>${writer() ? '这台设备可以记分、撤销和结束本场。' : '这台设备可以查看本场记录。'}</p></div><span class="badge ${writer() ? '' : 'neutral'}">${writer() ? '记分人' : '查看者'}</span></div><div class="settings-row"><div><h3>导出本场记录</h3><p>保存分数与统计，不含管理密钥。</p></div><button class="button secondary small" data-action="export">${icon('download')}导出</button></div>${writer() ? `<div class="settings-row"><div><h3>本场管理密钥</h3><p>请保存，换手机后可恢复记分权限。</p></div><button class="button secondary small" data-action="reveal-key">${reveal ? '已显示' : '显示密钥'}</button></div><div class="share-key">${reveal ? esc(gameKey(state.game.id)) : '••••••••••••••••••••••••'}</div>${reveal ? '<button class="text-button" data-action="copy-key">复制管理密钥</button>' : ''}` : `<div class="settings-row"><div><h3>恢复记分权限</h3><p>输入本场管理密钥后即可记分。</p></div><button class="button secondary small" data-action="restore-key">输入密钥</button></div>`}<div class="modal-actions"><button class="button secondary" data-action="close">完成</button></div>`);
}
function restoreKeyDialog() {
  openModal('恢复本场记分权限', '请输入这场牌局的管理密钥。', `<form id="restore-key-form"><div class="field"><label for="write-key">管理密钥</label><input id="write-key" name="key" type="password" autocomplete="off" required autofocus></div><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button secondary" type="button" data-action="close">取消</button><button class="button primary" type="submit" data-mutate>验证并恢复</button></div></form>`);
}
function confirmation(type) {
  const game = state.game; if (!game || !writer() || game.status !== 'active') return;
  const isUndo = type === 'undo', last = game.rounds.at(-1); if (isUndo && !last) return;
  openModal(isUndo ? `撤销第 ${last.number} 局？` : '结束本场牌局？', isUndo ? '本局记录将移除，等级与主庄恢复到本局开始时。' : '结束后生成名次和统计，并计入所有参与者的历史成绩。', `<div class="muted-box">${isUndo ? `第 ${last.number} 局 · ${last.type === 'wrong' ? esc(playerName(game, last.wrongPlayer)) + '错牌' : '闲家 ' + last.score + ' 分'}<br>${outcome(last)}<br>恢复主庄：${esc(playerName(game, Object.hasOwn(last, 'mainDealerBefore') ? last.mainDealerBefore : last.mainDealer))}` : `${esc(title(game))} · 共 ${countRounds(game)} 局<br>${game.players.map(esc).join(' · ')}${!countRounds(game) ? '<br>本场尚未记分，结束后不计入用户历史成绩。' : ''}`}</div><div class="form-error" role="alert"></div><div class="modal-actions"><button class="button secondary" data-action="close">继续打牌</button><button class="button ${isUndo ? 'danger' : 'primary'}" data-action="confirm-${type}" data-mutate>${isUndo ? '确认撤销' : '结束并生成统计'}</button></div>`);
}
async function copy(value, message = '已复制') {
  try { await navigator.clipboard.writeText(value); toast(message); }
  catch { const input = $('#share-url'); if (input) { input.focus(); input.select(); toast('请长按选中的链接复制'); } else toast('浏览器未允许复制，请手动选择后复制', true); }
}
function exportRecords() {
  if (!state.game) return;
  const data = { format: 'five-friends-card-journal', formatVersion: 3, exportedAt: new Date().toISOString(), game: state.game, statistics: statsFor(state.game) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `五人牌局-${title(state.game).replace(/[\\/:*?"<>|]/g, '-')}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('本场记录已导出');
}
async function legacyDialog() {
  let credentials; try { credentials = legacySession(); } catch (error) { showError(error); return; }
  if (!credentials) return;
  openModal('旧版记录', '正在读取以前保存的分数。', '<div class="loading-panel"><div class="spin"></div></div>', 'legacy');
  try {
    const { room } = await api('getLegacyRoom'); state.legacyRoom = room;
    if (state.modalType !== 'legacy') return;
    openModal('旧版记录', `${room.games?.length || 0} 场牌局`, `<div class="muted-box">旧记录仍然保留。导入后将显示在本站所有牌局和用户历史中；同名玩家将关联已有用户。${credentials.writeKey ? '' : ' 当前链接只有查看权限；如果保存了旧版管理密钥，可在下方输入后导入。'}</div><div class="legacy-games">${(room.games || []).map(game => `<details class="legacy-game"><summary>${esc(game.title || `${date(game.createdAt)}牌局`)} · ${countRounds(game)} 局</summary><p>${game.players.map(esc).join(' · ')}</p><div class="round-list">${[...(game.rounds || [])].reverse().map(r => roundEntry(r, game, true)).join('') || '<div class="round-list-empty">没有分数记录。</div>'}</div></details>`).join('') || '<div class="round-list-empty">没有旧记录。</div>'}</div>${credentials.writeKey ? '' : '<div class="field"><label for="legacy-write-key">旧版管理密钥</label><input id="legacy-write-key" type="password" autocomplete="off" placeholder="输入以前保存的管理密钥" data-mutate><p class="field-help">仅用于本次导入，不会保存输入的旧版密钥。</p></div>'}<div class="form-error" role="alert"></div><div class="modal-actions"><button class="button secondary" data-action="close">关闭</button><button class="button primary" data-action="import-legacy" data-mutate>${credentials.writeKey ? '导入新版历史' : '输入密钥并导入'}</button></div>`, 'legacy');
  } catch (error) {
    if (state.modalType !== 'legacy') return;
    openModal('旧版记录暂时无法读取', '', `<div class="muted-box">${esc(error.message || '请稍后再试')}</div><div class="modal-actions"><button class="button secondary" data-action="close">关闭</button><button class="button primary" data-action="legacy">重试</button></div>`, 'legacy');
  }
}
document.addEventListener('input', event => {
  if (event.target.id === 'idle-score') { state.score = event.target.value; updatePreview(); }
  if (event.target.id === 'user-search') { state.userSearch = event.target.value; $('#user-list').innerHTML = userListHtml(); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'wrong-player') { state.wrongPlayer = event.target.value === '' ? null : Number(event.target.value); updatePreview(); }
  if (event.target.id === 'main-dealer') { state.mainDealer = event.target.value === '' ? null : Number(event.target.value); if (state.viceDealer === state.mainDealer) state.viceDealer = null; render(); }
  if (event.target.closest('#new-game-form') && event.target.matches('select')) {
    rememberNewGameDraft();
    const selects = [...document.querySelectorAll('#new-game-form select')], selected = selects.map(s => s.value);
    selects.forEach(select => [...select.options].forEach(option => { option.disabled = Boolean(option.value && option.value !== select.value && selected.includes(option.value)); }));
  }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (state.busy && ['close', 'nav', 'open-game', 'open-user', 'new-game', 'create-user'].includes(action)) return;
  if (action === 'nav') navigate(button.dataset.hash || '');
  else if (action === 'open-game') navigate(gameRoute(button.dataset.id));
  else if (action === 'open-user' && button.dataset.id) navigate(userRoute(button.dataset.id));
  else if (action === 'close') closeModal();
  else if (action === 'new-game') newGameDialog();
  else if (action === 'create-user') createUserDialog();
  else if (action === 'inline-user') createUserDialog(Number(button.dataset.seat));
  else if (action === 'refresh') await route(true);
  else if (action === 'share') shareDialog();
  else if (action === 'settings') settingsDialog();
  else if (action === 'reveal-key') settingsDialog(true);
  else if (action === 'restore-key') restoreKeyDialog();
  else if (action === 'export') exportRecords();
  else if (action === 'copy-share') await copy(shareUrl(), '查看链接已复制');
  else if (action === 'copy-key') await copy(gameKey(state.game.id) || '', '管理密钥已复制');
  else if (action === 'result-type') { state.resultType = button.dataset.type; render(); }
  else if (action === 'vice') {
    state.viceDealer = Number(button.dataset.seat);
    document.querySelectorAll('[data-action="vice"]').forEach(el => { const on = Number(el.dataset.seat) === state.viceDealer; el.classList.toggle('selected', on); el.setAttribute('aria-pressed', String(on)); }); updatePreview();
  } else if (action === 'toggle-rounds') { state.allRounds = !state.allRounds; const vice = state.viceDealer, score = state.score; render(); state.viceDealer = vice; state.score = score; }
  else if (action === 'history-filter') { state.historyFilter = button.dataset.filter; render(); }
  else if (action === 'undo' || action === 'finish') confirmation(action);
  else if (action === 'confirm-undo' || action === 'confirm-finish') {
    const isUndo = action === 'confirm-undo', game = state.game;
    await request(isUndo ? 'undoRound' : 'finishGame', { gameId: game.id }, result => {
      closeModal(true); render();
      const message = result.backup?.status === 'queued' ? '本场已结束，GitHub 备份已安排' : result.backup?.status === 'pending' ? '本场已结束，GitHub 备份将在后台重试' : '本场已结束，统计已生成';
      toast(isUndo ? '已撤销上一局，等级与主庄已恢复' : message);
      if (!isUndo) window.scrollTo({ top: 0, behavior: 'smooth' });
    }, game.version);
  } else if (action === 'more-games') {
    await request('listGames', { cursor: state.nextCursor, limit: 50 }, result => {
      const ids = new Set(state.games.map(g => g.id)); state.games.push(...(result.games || []).filter(g => !ids.has(g.id))); state.nextCursor = result.nextCursor || null; render();
    });
  } else if (action === 'legacy') await legacyDialog();
  else if (action === 'import-legacy') {
    const credentials = legacySession(); if (!credentials?.roomId || state.busy) return;
    const writeKey = credentials.writeKey || $('#legacy-write-key')?.value.trim();
    if (!writeKey) { const errorBox = $('#modal .form-error'); if (errorBox) errorBox.textContent = '请输入以前保存的旧版管理密钥。'; return; }
    const originalLabel = button.textContent;
    let cursor = '0', completed = 0, total = state.legacyRoom?.games?.length || 0;
    const visited = new Set();
    const errorBox = $('#modal .form-error'); if (errorBox) errorBox.textContent = '';
    setBusy(true);
    try {
      do {
        if (visited.has(cursor)) throw new Error('导入进度暂时无法继续，请重试。');
        visited.add(cursor);
        button.textContent = total ? `正在导入第 ${completed + 1} / ${total} 场` : '正在导入旧版记录…';
        const result = await api('importLegacy', { roomId: credentials.roomId, writeKey, cursor });
        if (Number.isFinite(Number(result.total))) total = Number(result.total);
        completed += 1;
        cursor = result.nextCursor == null ? null : String(result.nextCursor);
      } while (cursor !== null);
      closeModal(true);
      await route(true);
      toast('旧版记录已导入，历史成绩已关联');
    } catch (error) {
      const message = `${error.message || '导入暂时未完成'} 部分记录可能已导入，可重试；旧记录保留。`;
      const currentErrorBox = $('#modal .form-error');
      if (currentErrorBox && $('#modal').open) currentErrorBox.textContent = message; else toast(message, true);
    } finally {
      button.textContent = originalLabel;
      setBusy(false);
    }
  }
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['round-form', 'new-game-form', 'create-user-form', 'restore-key-form'].includes(form.id)) return;
  event.preventDefault(); if (state.busy) return; const data = new FormData(form);
  if (form.id === 'round-form') {
    const p = preview(), game = state.game; if (!p) return;
    await request('addRound', p.type === 'wrong' ? { gameId: game.id, type: 'wrong', wrongPlayer: p.wrongPlayer } : { gameId: game.id, type: 'score', mainDealer: p.mainDealer, viceDealer: p.viceDealer, score: p.score }, () => { render(); toast('本局已保存，开始下一局'); }, game.version);
  } else if (form.id === 'new-game-form') {
    rememberNewGameDraft(); const draft = state.newGameDraft;
    if (new Set(draft.playerIds).size !== 5 || draft.playerIds.some(id => !state.users.some(u => u.id === id))) { $('#modal .form-error').textContent = '请选择 5 位不同的已有用户。'; return; }
    await request('createGame', { title: draft.title.trim(), playerIds: draft.playerIds, mainDealer: draft.mainDealer }, result => { closeModal(true); navigate(gameRoute(result.game.id)); toast('新一场开始，祝你们好牌'); });
  } else if (form.id === 'create-user-form') {
    const seat = state.inlineSeat, inline = state.modalType === 'inline-user';
    await request('createUser', { name: String(data.get('name')).trim() }, result => {
      state.users.push(result.user); state.users.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      if (inline && seat !== null) { state.newGameDraft.playerIds[seat] = result.user.id; newGameDialog(true); }
      else { closeModal(true); render(); }
      toast(`已创建用户 ${result.user.name}`);
    });
  } else if (form.id === 'restore-key-form') {
    const gameId = state.game.id, previous = gameKey(gameId), candidate = String(data.get('key')).trim();
    setBusy(true);
    try {
      saveGameKey(gameId, candidate);
      const result = await api('verifyGameManager', { gameId }); if (result.game) syncGame(result.game);
      closeModal(true); render(); toast('密钥已验证，记分权限已恢复');
    } catch (error) { saveGameKey(gameId, previous || null); showError(error); }
    finally { setBusy(false); }
  }
});
window.addEventListener('hashchange', () => { closeModal(true); route(); });
$('#modal').addEventListener('cancel', event => {
  if (state.busy || state.modalType === 'inline-user') { event.preventDefault(); if (!state.busy) newGameDialog(true); }
  else state.modalType = null;
});
$('#modal').addEventListener('click', event => {
  if (event.target === $('#modal') && !state.busy) {
    const bounds = $('#modal').getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientY < bounds.top || event.clientX > bounds.right || event.clientY > bounds.bottom) closeModal();
  }
});
route();

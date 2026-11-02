import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHandler, COLLECTION, MAX_ROUNDS, MAX_GAME_BYTES } = require('../cloudfunctions/scorekeeper/v2.cjs');
const { createHandler: legacyHandler } = require('../cloudfunctions/scorekeeper/service.cjs');

/** Serialized copy-on-write transactions model atomic commits and rollback. */
function memoryDb() {
  const store = new Map();
  let queue = Promise.resolve();
  let queriedPages = 0;
  const transactionOperationCounts = [];
  const collection = (name, data = store, operation = () => {}) => ({
    doc: (id) => ({
      get: async () => { operation(); return { data: data.has(`${name}/${id}`) ? [structuredClone(data.get(`${name}/${id}`))] : [] }; },
      set: async (value) => { operation(); data.set(`${name}/${id}`, structuredClone(value)); },
    }),
    where: (filter) => {
      let offset = 0;
      let count = 100;
      const query = {
        skip: (value) => { offset = value; return query; },
        limit: (value) => { count = value; return query; },
        get: async () => {
          queriedPages += 1;
          return { data: [...data.entries()].filter(([key, doc]) => key.startsWith(`${name}/`) && Object.entries(filter).every(([field, value]) => doc[field] === value)).slice(offset, offset + count).map(([, doc]) => structuredClone(doc)) };
        },
      };
      return query;
    },
  });
  return {
    store,
    collection,
    transactionOperationCounts,
    get queriedPages() { return queriedPages; },
    runTransaction: (callback) => {
      const task = queue.then(async () => {
        const working = new Map([...store].map(([key, value]) => [key, structuredClone(value)]));
        let operations = 0;
        let result;
        try { result = await callback({ collection: (name) => collection(name, working, () => { operations += 1; }) }); }
        finally { transactionOperationCounts.push(operations); }
        store.clear();
        for (const [key, value] of working) store.set(key, value);
        return result;
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}

async function setup(options = {}) {
  const db = memoryDb();
  let id = 0;
  let token = 0;
  const handle = createHandler({ db, now: () => '2026-10-29T09:00:00.000Z', randomId: () => (++id).toString(16).padStart(32, '0'), randomKey: () => Buffer.alloc(32, ++token).toString('base64url'), ...options });
  const call = (action, payload = {}, extra = {}) => handle({ apiVersion: 2, action, payload, ...extra });
  const users = [];
  for (const name of ['一', '二', '三', '四', '五']) users.push((await call('createUser', { name })).user);
  const payload = { title: '周末牌局', playerIds: users.map((user) => user.id), mainDealer: 0 };
  const created = await call('createGame', payload);
  assert.ok(created.game, JSON.stringify(created));
  const auth = { gameId: created.game.id, writeKey: created.writeKey };
  return { db, handle, call, users, payload, created, auth };
}

test('unexpected database errors expose only a safe diagnostic identifier', async () => {
  for (const [error, diagnostic] of [
    [{ code: 'DATABASE_REQUEST_FAILED', message: 'private credential=secret' }, 'DATABASE_REQUEST_FAILED'],
    [{ code: 'unsafe credential=secret', message: 'private' }, 'UNKNOWN'],
    [new TypeError('private request body'), 'TypeError'],
  ]) {
    const db = { collection: () => { throw error; } };
    const result = await createHandler({ db })({ apiVersion: 2, action: 'listUsers' });
    assert.equal(result.error.code, 'SERVER_ERROR');
    assert.equal(result.error.message, `云端暂时无法处理，请稍后重试（${diagnostic}）`);
    assert.doesNotMatch(JSON.stringify(result), /private|credential|secret|request body/);
  }
});

test('finish dispatches backup only after commit and backup failure never rolls settlement back', async () => {
  let db, called = 0, committed;
  const context = await setup({ onGameFinished: async game => {
    called++;
    const saved = db.store.get(`${COLLECTION}/${game.id}`);
    committed = saved?.status === 'finished' && saved.version === game.version;
    throw new Error('GitHub unavailable');
  } });
  db = context.db;
  const failed = await context.call('finishGame', {}, { ...context.auth, writeKey: 'bad', expectedVersion: 0 });
  assert.equal(failed.error.code, 'UNAUTHORIZED');
  assert.equal(called, 0);
  const ended = await context.call('finishGame', {}, { ...context.auth, expectedVersion: 0 });
  assert.equal(ended.game.status, 'finished');
  assert.equal(ended.game.version, 1);
  assert.deepEqual(ended.backup, { status: 'pending' });
  assert.equal(called, 1);
  assert.equal(committed, true, 'backup must observe the committed settlement');
  await context.call('finishGame', {}, { ...context.auth, expectedVersion: 0 });
  assert.equal(called, 1, 'a stale repeated finish must not dispatch again');
});

test('wrong play is authorized and versioned, survives reload, and manual dealers cannot be forged later', async () => {
  const { call, auth, users } = await setup();
  assert.equal((await call('addRound', { type: 'wrong', wrongPlayer: 1 }, { ...auth, writeKey: 'bad', expectedVersion: 0 })).error.code, 'UNAUTHORIZED');
  assert.equal((await call('addRound', { type: 'wrong' }, { ...auth, expectedVersion: 0 })).error.code, 'VALIDATION');
  const wrong = await call('addRound', { type: 'wrong', wrongPlayer: 1, levels: Array(5).fill('A'), nextMainDealer: 3 }, { ...auth, expectedVersion: 0 });
  assert.deepEqual(wrong.game.levels, ['3', '2', '3', '3', '3']);
  assert.equal(wrong.game.mainDealer, null);
  assert.equal((await call('getGame', {}, auth)).game.rounds[0].wrongPlayer, 1);
  assert.equal((await call('addRound', { viceDealer: 1, score: 80 }, { ...auth, expectedVersion: 1 })).error.code, 'VALIDATION');
  assert.equal((await call('addRound', { type: 'wrong', wrongPlayer: 2 }, { ...auth, expectedVersion: 0 })).error.code, 'STALE_VERSION');
  const normal = await call('addRound', { mainDealer: 3, viceDealer: 4, score: 120 }, { ...auth, expectedVersion: 1 });
  assert.equal(normal.game.rounds[1].mainDealer, 3);
  assert.equal(normal.game.rounds[1].viceDealer, 4);
  const undone = await call('undoRound', {}, { ...auth, expectedVersion: 2 });
  assert.equal(undone.game.mainDealer, null);
  assert.deepEqual(undone.game.levels, wrong.game.levels);
  const ended = await call('finishGame', {}, { ...auth, expectedVersion: 3 });
  assert.deepEqual(ended.game.statistics.map(row => row.rank), [1, 1, 1, 1, 5]);
  const history = await call('getUserHistory', { userId: users[0].id });
  assert.equal(history.stats.completedGames, 1);
  assert.equal(history.stats.mainDealerRounds, 0);
  assert.equal(history.stats.viceDealerRounds, 0);
  assert.equal(history.stats.mainDealerAverage, null);
  assert.equal(history.stats.mainDealerConcededUpgradeAverage, null);
  assert.equal((await call('getUserHistory', { userId: users[1].id })).stats.wrongRounds, 1);
});

test('nickname registration normalizes NFKC, whitespace and case atomically', async () => {
  const { call, db } = await setup();
  const results = await Promise.all([call('createUser', { name: ' Ａlice ' }), call('createUser', { name: 'alice' })]);
  assert.equal(results.filter((value) => value.user).length, 1);
  assert.equal(results.filter((value) => value.error?.code === 'DUPLICATE_USER').length, 1);
  const registered = results.find((value) => value.user).user;
  assert.equal(registered.name, 'Alice');
  assert.match(registered.id, /^u_[a-f0-9]{32}$/);
  assert.equal(db.store.get(`${COLLECTION}/${registered.id}`).normalizedName, 'alice');
  const listed = await call('listUsers');
  assert.equal(listed.users.length, 6);
  assert.deepEqual(Object.keys(listed.users[0]).sort(), ['createdAt', 'id', 'name']);
  for (const name of ['', ' ', 'a\nb', '\u0000abc', '名'.repeat(21), null, 99]) {
    assert.equal((await call('createUser', { name })).error.code, 'VALIDATION');
  }
});

test('five existing distinct profiles are required and server derives names', async () => {
  const { call, payload } = await setup();
  for (const bad of [[], payload.playerIds.slice(0, 4), [...payload.playerIds.slice(0, 4), payload.playerIds[0]], [...payload.playerIds.slice(0, 4), 'u_' + 'f'.repeat(32)]]) {
    const result = await call('createGame', { ...payload, playerIds: bad });
    assert.ok(['VALIDATION', 'NOT_FOUND'].includes(result.error.code));
  }
  const next = await call('createGame', { ...payload, players: ['伪', '造', '名', '字', '！'], levels: Array(5).fill('A') });
  assert.deepEqual(next.game.players, ['一', '二', '三', '四', '五']);
  assert.deepEqual(next.game.levels, Array(5).fill('2'));
  assert.equal(next.game.version, 0);
  assert.equal((await call('listGames')).games.length, 2, 'independent active games are allowed');
});

test('public lists and game reads omit all management data and legacy rooms', async () => {
  const { call, db, auth, created } = await setup();
  const stored = db.store.get(`${COLLECTION}/${auth.gameId}`);
  assert.equal(created.writeKey.length, 43);
  assert.equal(stored.writeKeyHash.length, 64);
  assert.ok(!JSON.stringify(stored).includes(created.writeKey));
  stored.internalSecret = 'private-future-field';
  db.store.set(`${COLLECTION}/${'f'.repeat(32)}`, { id: 'f'.repeat(32), title: 'hidden-old-room', games: [], readKeyHash: 'secret' });
  const read = await call('getGame', {}, { gameId: auth.gameId });
  const listed = await call('listGames');
  assert.equal(listed.games.length, 1);
  assert.ok(!('rounds' in listed.games[0]));
  assert.equal(listed.games[0].roundCount, 0);
  for (const value of [read, listed]) {
    assert.ok(!JSON.stringify(value).includes(stored.writeKeyHash));
    assert.ok(!JSON.stringify(value).includes('private-future-field'));
    assert.ok(!JSON.stringify(value).includes('hidden-old-room'));
  }
});

test('management verification requires the correct per-game capability', async () => {
  const { call, auth, payload } = await setup();
  const second = await call('createGame', payload);
  assert.ok((await call('verifyGameManager', {}, auth)).game);
  for (const writeKey of [undefined, '', 'x'.repeat(43), {}, second.writeKey]) {
    assert.equal((await call('verifyGameManager', {}, { ...auth, writeKey })).error.code, 'UNAUTHORIZED');
    assert.equal((await call('addRound', { viceDealer: 1, score: 0 }, { ...auth, writeKey, expectedVersion: 0 })).error.code, 'UNAUTHORIZED');
  }
  assert.equal((await call('verifyGameManager', {}, { gameId: 'g_' + 'f'.repeat(32), writeKey: auth.writeKey })).error.code, 'UNAUTHORIZED');
});

test('settlement and statistics are server-derived; finish records safe final statistics', async () => {
  const { call, auth, users, db } = await setup();
  const first = await call('addRound', { viceDealer: 1, score: 35, mainDealer: 4, nextMainDealer: 4, statistics: [{ rank: 1 }], levels: Array(5).fill('A') }, { ...auth, expectedVersion: 0 });
  assert.deepEqual(first.game.levels, ['5', '5', '2', '2', '2']);
  assert.equal(first.game.mainDealer, 1);
  assert.equal(first.game.rounds[0].mainDealer, 0);
  const second = await call('addRound', { viceDealer: 4, score: 200 }, { ...auth, expectedVersion: 1 });
  assert.equal(second.game.mainDealer, 2);
  const finished = await call('finishGame', { statistics: [{ userId: users[4].id, rank: 1 }] }, { ...auth, expectedVersion: 2 });
  assert.equal(finished.game.status, 'finished');
  assert.equal(finished.game.version, 3);
  const best = finished.game.statistics[0];
  assert.equal(best.userId, users[0].id);
  assert.equal(best.totalUpgrade, 5);
  assert.equal(best.rank, 1);
  assert.equal(best.mainDealerRounds, 1);
  assert.equal(best.idleRounds, 1);
  assert.equal(best.mainDealerAverage, 35);
  assert.equal(best.idleAverage, 200);
  const stored = db.store.get(`${COLLECTION}/${auth.gameId}`);
  assert.deepEqual(stored.statistics, finished.game.statistics);
  stored.statistics = [{ rank: 999, secret: 'forged-stored-summary' }];
  assert.equal((await call('getGame', {}, auth)).game.statistics[0].rank, 1);
  assert.equal((await call('addRound', { viceDealer: 1, score: 0 }, { ...auth, expectedVersion: 3 })).error.code, 'GAME_FINISHED');
});

test('same-version concurrent saves append once; failed and stale mutations roll back', async () => {
  const { call, auth } = await setup();
  const saves = await Promise.all([call('addRound', { viceDealer: 1, score: 0 }, { ...auth, expectedVersion: 0 }), call('addRound', { viceDealer: 1, score: 0 }, { ...auth, expectedVersion: 0 })]);
  assert.equal(saves.filter((value) => value.game).length, 1);
  assert.equal(saves.filter((value) => value.error?.code === 'STALE_VERSION').length, 1);
  const before = (await call('getGame', {}, auth)).game;
  for (const payload of [{ viceDealer: 1, score: -1 }, { viceDealer: 1, score: '' }, { viceDealer: 1, score: 120 }]) {
    assert.equal((await call('addRound', payload, { ...auth, expectedVersion: 1 })).error.code, 'VALIDATION');
  }
  assert.deepEqual((await call('getGame', {}, auth)).game, before);
  const undone = await call('undoRound', {}, { ...auth, expectedVersion: 1 });
  assert.deepEqual(undone.game.levels, Array(5).fill('2'));
  assert.equal(undone.game.mainDealer, 0);
  assert.equal(undone.game.roundCount, 0);
  assert.equal((await call('undoRound', {}, { ...auth, expectedVersion: 2 })).error.code, 'NO_ROUNDS');
});

test('career means use all completed rounds and exclude active or empty games', async () => {
  const { call, auth, payload, users } = await setup();
  await call('addRound', { viceDealer: 1, score: 80 }, { ...auth, expectedVersion: 0 });
  await call('addRound', { viceDealer: 0, score: 40 }, { ...auth, expectedVersion: 1 });
  await call('finishGame', {}, { ...auth, expectedVersion: 2 });
  const next = await call('createGame', payload);
  await call('addRound', { viceDealer: 1, score: 200 }, { gameId: next.game.id, writeKey: next.writeKey, expectedVersion: 0 });
  const empty = await call('createGame', payload);
  await call('finishGame', {}, { gameId: empty.game.id, writeKey: empty.writeKey, expectedVersion: 0 });
  const history = await call('getUserHistory', { userId: users[0].id });
  assert.equal(history.user.id, users[0].id);
  assert.equal(history.stats.completedGames, 1);
  assert.equal(history.stats.mainDealerRounds, 1);
  assert.equal(history.stats.viceDealerRounds, 1);
  assert.equal(history.stats.idleRounds, 0);
  assert.equal(history.stats.mainDealerAverage, 80);
  assert.equal(history.stats.viceDealerAverage, 40);
  assert.equal(history.stats.idleAverage, null);
  assert.equal(history.stats.history.length, 1);
  assert.equal(history.games.length, 2, 'empty finished games remain viewable but have no ranking');
});

test('list pagination and user statistics read beyond the SDK default page', async () => {
  const { call, db, auth, users } = await setup();
  await call('addRound', { viceDealer: 1, score: 120 }, { ...auth, expectedVersion: 0 });
  await call('finishGame', {}, { ...auth, expectedVersion: 1 });
  const template = db.store.get(`${COLLECTION}/${auth.gameId}`);
  for (let index = 2; index <= 105; index += 1) {
    const id = `g_${index.toString(16).padStart(32, '0')}`;
    db.store.set(`${COLLECTION}/${id}`, { ...structuredClone(template), id, createdAt: `2026-10-${String((index % 28) + 1).padStart(2, '0')}T09:00:00.000Z` });
  }
  const first = await call('listGames');
  assert.equal(first.games.length, 100);
  assert.equal(first.nextCursor, '100');
  const last = await call('listGames', { cursor: first.nextCursor });
  assert.equal(last.games.length, 5);
  assert.ok(!last.nextCursor);
  assert.equal(new Set([...first.games, ...last.games].map((game) => game.id)).size, 105);
  assert.equal((await call('getUserHistory', { userId: users[0].id })).stats.completedGames, 105);
  assert.ok(db.queriedPages >= 6);
});

test('game document collision, round cap and byte cap never commit partial writes', async () => {
  const { call, db, auth, payload } = await setup();
  const collision = createHandler({ db, randomId: () => auth.gameId.slice(2) });
  assert.equal((await collision({ apiVersion: 2, action: 'createGame', payload })).error.code, 'RETRY');
  const key = `${COLLECTION}/${auth.gameId}`;
  const full = structuredClone(db.store.get(key));
  full.rounds = Array.from({ length: MAX_ROUNDS }, () => ({ id: 'historical' }));
  db.store.set(key, full);
  assert.equal((await call('addRound', { viceDealer: 1, score: 120 }, { ...auth, expectedVersion: 0 })).error.code, 'ROUND_LIMIT');
  assert.equal(db.store.get(key).version, 0);
  full.rounds = [];
  full.padding = 'x'.repeat(MAX_GAME_BYTES);
  db.store.set(key, full);
  assert.equal((await call('finishGame', {}, { ...auth, expectedVersion: 0 })).error.code, 'GAME_FULL');
  assert.equal(db.store.get(key).status, 'active');
  assert.equal(db.store.get(key).version, 0);
});

test('legacy import requires manager authority, is idempotent and preserves originals', async () => {
  const { db, call } = await setup();
  let counter = 1000;
  let keyNumber = 0;
  const legacy = legacyHandler({ db, randomId: () => (++counter).toString(16).padStart(32, '0'), randomKey: () => Buffer.alloc(32, ++keyNumber + 10).toString('base64url') });
  const old = await legacy({ action: 'createRoom', payload: { title: '旧牌桌' } });
  const oldAuth = { roomId: old.room.id, writeKey: old.writeKey };
  const started = await legacy({ action: 'createGame', ...oldAuth, expectedVersion: 0, payload: { players: ['一', '二', '三', '四', '六'], mainDealer: 0 } });
  const oldGame = started.room.games[0];
  await legacy({ action: 'addRound', ...oldAuth, expectedVersion: 1, payload: { gameId: oldGame.id, viceDealer: 1, score: 0 } });
  await legacy({ action: 'finishGame', ...oldAuth, expectedVersion: 2, payload: { gameId: oldGame.id } });
  const before = structuredClone(db.store.get(`${COLLECTION}/${old.room.id}`));
  assert.equal((await call('listGames')).games.length, 1, 'legacy games are hidden until explicit import');
  assert.equal((await call('importLegacy', { ...oldAuth, writeKey: old.readKey })).error.code, 'UNAUTHORIZED');
  const imported = await call('importLegacy', oldAuth);
  assert.ok(imported.games, JSON.stringify(imported));
  assert.equal(imported.games.length, 1);
  assert.equal(imported.users.length, 5);
  assert.equal(imported.alreadyImported, false);
  assert.equal(imported.games[0].id, `g_legacy_${oldGame.id}`);
  assert.equal(imported.games[0].statistics[0].totalUpgrade, 4);
  const id = imported.games[0].id;
  assert.ok((await call('verifyGameManager', {}, { gameId: id, writeKey: imported.writeKeys[id] })).game);
  const again = await call('importLegacy', oldAuth);
  assert.equal(again.alreadyImported, true);
  assert.deepEqual(again.writeKeys, imported.writeKeys, 'legacy managers can recover the same game capabilities');
  assert.equal((await call('listGames')).games.length, 2);
  assert.equal((await call('listUsers')).users.length, 6, 'shared names reuse the same registered profile');
  assert.deepEqual(db.store.get(`${COLLECTION}/${old.room.id}`), before);
  assert.ok((await legacy({ action: 'getRoom', roomId: old.room.id, readKey: old.readKey })).room, 'old viewer links continue working');
});

test('malformed API requests return actionable validation instead of SDK details', async () => {
  const { call, handle, auth } = await setup();
  for (const event of [null, [], {}, { apiVersion: 1, action: 'listUsers' }, { apiVersion: 2, action: 'other' }, { apiVersion: 2, action: 'getGame', gameId: '../../anything' }, { apiVersion: 2, action: 'listUsers', payload: [] }, { apiVersion: 2, action: 'listUsers', payload: null }]) {
    assert.equal((await handle(event)).error.code, 'VALIDATION');
  }
  assert.equal((await call('addRound', { viceDealer: 1, score: 120 }, auth)).error.code, 'VALIDATION');
  for (const cursor of ['-1', '1.5', '10000', 'garbage', 0]) assert.equal((await call('listGames', { cursor })).error.code, 'VALIDATION');
  assert.equal((await call('getUserHistory', { userId: 'u_' + 'f'.repeat(32) })).error.code, 'NOT_FOUND');
});

test('fifty legacy games import in bounded retry-safe pages without altering originals', async () => {
  const { db, call, auth } = await setup();
  let counter = 1000;
  let keyNumber = 0;
  const legacy = legacyHandler({ db, randomId: () => (++counter).toString(16).padStart(32, '0'), randomKey: () => Buffer.alloc(32, ++keyNumber + 10).toString('base64url') });
  const old = await legacy({ action: 'createRoom', payload: { title: '批量历史牌局' } });
  const oldAuth = { roomId: old.room.id, writeKey: old.writeKey };
  const empty = await call('importLegacy', oldAuth);
  assert.deepEqual(empty.games, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.nextCursor, null);
  assert.equal(empty.importedCount, 0);
  const started = await legacy({ action: 'createGame', ...oldAuth, expectedVersion: 0, payload: { players: ['旧一', '旧二', '旧三', '旧四', '旧五'], mainDealer: 0 } });
  const sourceKey = `${COLLECTION}/${old.room.id}`;
  const source = db.store.get(sourceKey);
  source.games = Array.from({ length: 50 }, (_, index) => ({ ...structuredClone(started.room.games[0]), id: (2000 + index).toString(16).padStart(32, '0'), status: 'finished', finishedAt: '2026-10-29T09:00:00.000Z' }));
  const before = structuredClone(source);
  const imported = await call('importLegacy', oldAuth);
  assert.equal(imported.games.length, 1, 'each request imports only one game');
  assert.equal(imported.total, 50);
  assert.equal(imported.importedCount, 1);
  assert.equal(imported.nextCursor, '1');
  assert.equal((await call('listGames')).games.length, 2);
  const retried = await call('importLegacy', oldAuth);
  assert.equal(retried.alreadyImported, true);
  assert.equal(retried.importedCount, 0);
  assert.deepEqual(retried.writeKeys, imported.writeKeys);
  assert.equal(retried.nextCursor, '1');
  const importedIds = [imported.games[0].id];
  let cursor = imported.nextCursor;
  while (cursor) {
    const page = await call('importLegacy', { ...oldAuth, cursor });
    assert.equal(page.games.length, 1);
    assert.equal(page.total, 50);
    assert.equal(page.importedCount, 1);
    importedIds.push(page.games[0].id);
    cursor = page.nextCursor;
  }
  assert.equal(new Set(importedIds).size, 50);
  assert.equal((await call('listGames')).games.length, 51);
  assert.equal((await call('listUsers')).users.length, 10);
  assert.deepEqual(db.store.get(sourceKey), before, 'source legacy room is never modified');
  assert.ok(db.transactionOperationCounts.every((count) => count <= 13), 'each page stays far below the 100-operation transaction limit');
  assert.ok((await call('getGame', {}, auth)).game, 'preexisting v2 game is preserved');
  const done = await call('importLegacy', { ...oldAuth, cursor: '50' });
  assert.deepEqual(done.games, []);
  assert.equal(done.nextCursor, null);
  assert.equal(done.importedCount, 0);
  for (const invalidCursor of ['51', '-1', 0, 'garbage']) assert.equal((await call('importLegacy', { ...oldAuth, cursor: invalidCursor })).error.code, 'VALIDATION');
});

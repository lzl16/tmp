import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHandler, COLLECTION } = require('../cloudfunctions/scorekeeper/service.cjs');

/** Serial transactions with rollback model the database's atomic read/modify/write. */
function memoryDb() {
  const store = new Map();
  let queue = Promise.resolve();
  const collection = (name, data = store) => ({
    doc: (id) => ({
      get: async () => ({ data: data.has(`${name}/${id}`) ? [structuredClone(data.get(`${name}/${id}`))] : [] }),
      set: async (value) => { data.set(`${name}/${id}`, structuredClone(value)); },
    }),
  });
  return {
    store,
    collection,
    runTransaction: (callback) => {
      const task = queue.then(async () => {
        const working = new Map([...store].map(([key, value]) => [key, structuredClone(value)]));
        const result = await callback({ collection: (name) => collection(name, working) });
        store.clear();
        for (const [key, value] of working) store.set(key, value);
        return result;
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}

async function setup() {
  const db = memoryDb();
  let id = 0;
  let key = 0;
  const handle = createHandler({
    db,
    now: () => '2026-10-29T09:00:00.000Z',
    randomId: () => (++id).toString(16).padStart(32, '0'),
    randomKey: () => Buffer.alloc(32, ++key).toString('base64url'),
  });
  const created = await handle({ action: 'createRoom', payload: { title: '周末牌局' } });
  assert.ok(created.room);
  const auth = { roomId: created.room.id, readKey: created.readKey, writeKey: created.writeKey };
  const gameResult = await handle({ action: 'createGame', ...auth, expectedVersion: 0, payload: { players: ['一', '二', '三', '四', '五'], mainDealer: 4 } });
  assert.ok(gameResult.room);
  return { db, handle, created, auth, game: gameResult.room.games[0] };
}

test('room creation returns capability keys once and stores only salted hashes', async () => {
  const { db, handle, created, auth } = await setup();
  assert.equal(created.readKey.length, 43);
  assert.notEqual(created.readKey, created.writeKey);
  const stored = db.store.get(`${COLLECTION}/${auth.roomId}`);
  assert.equal(stored.readKeyHash.length, 64);
  assert.equal(stored.writeKeyHash.length, 64);
  assert.ok(!JSON.stringify(stored).includes(created.writeKey));
  const read = await handle({ action: 'getRoom', roomId: auth.roomId, readKey: auth.readKey });
  assert.equal(read.room.title, '周末牌局');
  assert.deepEqual(Object.keys(read.room).sort(), ['id', 'title', 'version', 'createdAt', 'updatedAt', 'games'].sort());
  assert.ok(!JSON.stringify(read).includes(stored.writeKeyHash));
  assert.ok(!JSON.stringify(read).includes(stored.readKeyHash));
});

test('viewer key cannot mutate and an invalid link cannot read', async () => {
  const { handle, auth, game } = await setup();
  const denied = await handle({ action: 'addRound', roomId: auth.roomId, readKey: auth.readKey, expectedVersion: 1, payload: { gameId: game.id, viceDealer: 0, score: 0 } });
  assert.equal(denied.error.code, 'UNAUTHORIZED');
  const wrong = await handle({ action: 'getRoom', roomId: auth.roomId, readKey: 'x'.repeat(43) });
  assert.equal(wrong.error.code, 'UNAUTHORIZED');
  const missing = await handle({ action: 'getRoom', roomId: 'f'.repeat(32), readKey: auth.readKey });
  assert.deepEqual(wrong, missing);
});

test('server calculates settlement rather than accepting forged levels or next dealer', async () => {
  const { handle, auth, game } = await setup();
  const added = await handle({ action: 'addRound', ...auth, expectedVersion: 1, payload: { gameId: game.id, viceDealer: 0, score: 0, mainDealer: 2, nextMainDealer: 3, levels: Array(5).fill('A') } });
  assert.deepEqual(added.room.games[0].levels, ['6', '2', '2', '2', '6']);
  assert.equal(added.room.games[0].mainDealer, 0);
  assert.equal(added.room.games[0].rounds[0].mainDealer, 4);
  assert.equal(added.room.version, 2);
});

test('simultaneous submissions at the same version allow exactly one append', async () => {
  const { handle, auth, game } = await setup();
  const request = { action: 'addRound', ...auth, expectedVersion: 1, payload: { gameId: game.id, viceDealer: 0, score: 160 } };
  const results = await Promise.all([handle(request), handle(request)]);
  assert.equal(results.filter((value) => value.room).length, 1);
  assert.equal(results.filter((value) => value.error?.code === 'STALE_VERSION').length, 1);
  const read = await handle({ action: 'getRoom', ...auth });
  assert.equal(read.room.games[0].rounds.length, 1);
  assert.equal(read.room.version, 2);
});

test('invalid mutations leave version and records unchanged', async () => {
  const { handle, auth, game } = await setup();
  for (const payload of [
    { gameId: game.id, viceDealer: 4, score: 120 },
    { gameId: game.id, viceDealer: 0, score: -1 },
    { gameId: game.id, viceDealer: 0, score: '' },
  ]) {
    const result = await handle({ action: 'addRound', ...auth, expectedVersion: 1, payload });
    assert.equal(result.error.code, 'VALIDATION');
  }
  const read = await handle({ action: 'getRoom', ...auth });
  assert.equal(read.room.version, 1);
  assert.equal(read.room.games[0].rounds.length, 0);
});

test('cannot open another game while active; after finishing a new game starts at 2', async () => {
  const { handle, auth, game } = await setup();
  const newGame = { action: 'createGame', ...auth, expectedVersion: 1, payload: { players: game.players, mainDealer: 1 } };
  assert.equal((await handle(newGame)).error.code, 'ACTIVE_GAME');
  const finished = await handle({ action: 'finishGame', ...auth, expectedVersion: 1, payload: { gameId: game.id } });
  assert.equal(finished.room.games[0].status, 'finished');
  const opened = await handle({ ...newGame, expectedVersion: 2 });
  assert.equal(opened.room.games.length, 2);
  assert.deepEqual(opened.room.games[1].levels, Array(5).fill('2'));
});

test('undo restores levels and dealer atomically and rejects stale repeated undo', async () => {
  const { handle, auth, game } = await setup();
  await handle({ action: 'addRound', ...auth, expectedVersion: 1, payload: { gameId: game.id, viceDealer: 0, score: 35 } });
  const undone = await handle({ action: 'undoRound', ...auth, expectedVersion: 2, payload: { gameId: game.id } });
  assert.deepEqual(undone.room.games[0].levels, Array(5).fill('2'));
  assert.equal(undone.room.games[0].mainDealer, 4);
  assert.equal(undone.room.games[0].rounds.length, 0);
  assert.equal((await handle({ action: 'undoRound', ...auth, expectedVersion: 2, payload: { gameId: game.id } })).error.code, 'STALE_VERSION');
});

test('transaction collision does not overwrite existing room', async () => {
  const { db, auth } = await setup();
  const before = structuredClone(db.store.get(`${COLLECTION}/${auth.roomId}`));
  const handle = createHandler({ db, randomId: () => auth.roomId });
  const failed = await handle({ action: 'createRoom', payload: { title: '不能覆盖' } });
  assert.equal(failed.error.code, 'RETRY');
  assert.deepEqual(db.store.get(`${COLLECTION}/${auth.roomId}`), before);
});

test('malformed request and missing mutation version return actionable errors', async () => {
  const { handle, auth, game } = await setup();
  for (const event of [null, [], {}, { action: 'other' }, { action: 'getRoom', roomId: '../../x' }]) {
    assert.equal((await handle(event)).error.code, 'VALIDATION');
  }
  const missing = await handle({ action: 'addRound', ...auth, payload: { gameId: game.id, score: 120, viceDealer: 1 } });
  assert.equal(missing.error.code, 'VALIDATION');
});

test('malformed capability tokens never grant viewing or writing permission', async () => {
  const { handle, auth, game } = await setup();
  for (const token of [undefined, '', 'short', 'x'.repeat(44), '你'.repeat(43), [], {}, 123]) {
    assert.equal((await handle({ action: 'getRoom', roomId: auth.roomId, readKey: token })).error.code, 'UNAUTHORIZED');
    assert.equal((await handle({ action: 'finishGame', roomId: auth.roomId, readKey: auth.readKey, writeKey: token, expectedVersion: 1, payload: { gameId: game.id } })).error.code, 'UNAUTHORIZED');
  }
});

test('round and document size limits fail before any transaction is committed', async () => {
  const { db, handle, auth, game } = await setup();
  const key = `${COLLECTION}/${auth.roomId}`;
  const full = structuredClone(db.store.get(key));
  full.games[0].rounds = Array.from({ length: 200 }, () => ({ id: 'historical' }));
  db.store.set(key, full);
  const denied = await handle({ action: 'addRound', ...auth, expectedVersion: 1, payload: { gameId: game.id, viceDealer: 0, score: 120 } });
  assert.equal(denied.error.code, 'ROUND_LIMIT');
  assert.equal(db.store.get(key).version, 1);
  full.padding = 'x'.repeat(900_000);
  db.store.set(key, full);
  const tooLarge = await handle({ action: 'finishGame', ...auth, expectedVersion: 1, payload: { gameId: game.id } });
  assert.equal(tooLarge.error.code, 'ROOM_FULL');
  assert.equal(db.store.get(key).games[0].status, 'active');
  assert.equal(db.store.get(key).version, 1);
});

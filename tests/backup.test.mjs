import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRecords, createCloudReader, writeSnapshot } from '../scripts/backup-records.mjs';
import { createGame, applyRound, finishGame } from '../public/rules.mjs';
const require = createRequire(import.meta.url);
const { createBackupDispatcher } = require('../cloudfunctions/scorekeeper/github-backup.cjs');
const userId = number => 'u_' + number.toString(16).padStart(32, '0');
const gameId = number => 'g_' + number.toString(16).padStart(32, '0');

function fixture() {
  const users = ['甲', '乙', '丙', '丁', '戊'].map((name, i) => ({ id: userId(i + 1), name, createdAt: '2026-11-02', writeKey: 'hidden-user-key' }));
  let game = { ...createGame({ players: users.map(user => user.name), mainDealer: 0 }, { id: gameId(1), now: '2026-11-02' }), playerIds: users.map(user => user.id), version: 0 };
  game = applyRound(game, { viceDealer: 1, score: 0 }, { id: 'round-1', now: '2026-11-02' });
  game = { ...finishGame(game, '2026-11-02'), version: 2, roundCount: 1, writeKeyHash: 'hidden-game-hash', writeKey: 'hidden-game-key' };
  game.rounds[0].internalSecret = 'hidden-round-secret';
  const call = async (action, payload) => {
    if (action === 'listUsers') return { users };
    if (action === 'listGames') return { games: [game] };
    if (action === 'getGame') { assert.equal(payload.gameId, game.id); return { game }; }
    assert.fail(`unexpected write action ${action}`);
  };
  return { users, game, call };
}

test('full export preserves scores, levels, competition ranks and career totals without credentials', async () => {
  const { game, call } = fixture();
  const data = await collectRecords(call, { triggerGame: game.id });
  assert.equal(data.games[0].rounds[0].score, 0);
  assert.deepEqual(data.games[0].statistics.map(row => row.rank), [1, 2, 3, 3, 3]);
  assert.equal(data.userStatistics[0].mainDealerAverage, 0);
  assert.equal(data.userStatistics[0].mainDealerConcededUpgradeAverage, 0);
  assert.equal(data.userStatistics[0].mainDealerUpgradeAverage, 4);
  assert.equal(data.userStatistics[1].viceDealerUpgradeAverage, 4);
  assert.equal(data.userStatistics[2].idleConcededUpgradeAverage, 4);
  assert.equal(data.userStatistics[0].wrongRounds, 0);
  assert.equal(data.userStatistics[0].completedGames, 1);
  assert.equal(data.userStatistics[0].averageRank, 2);
  assert.ok(!JSON.stringify(data).includes('hidden-'));
  assert.ok(!JSON.stringify(data).includes('writeKey'));
});

test('backup preserves wrong player, pending main dealer and undo metadata with separated role statistics', async () => {
  const { game, call } = fixture();
  let changed = applyRound({ ...game, status: 'active' }, { type: 'wrong', wrongPlayer: 3 }, { id: 'wrong', now: 'later' });
  Object.assign(game, finishGame(changed, 'end'), { version: 4, roundCount: 2 });
  let data = await collectRecords(call);
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.games[0].mainDealer, null);
  assert.equal(data.games[0].rounds[1].type, 'wrong');
  assert.equal(data.games[0].rounds[1].wrongPlayer, 3);
  assert.equal(data.games[0].rounds[1].mainDealerBefore, 1);
  assert.equal(data.userStatistics[0].mainDealerRounds, 1);
  assert.equal(data.userStatistics[0].viceDealerRounds, 0);
  assert.equal(data.userStatistics[0].mainDealerAverage, 0);
  assert.equal(data.userStatistics[3].wrongRounds, 1);
  assert.equal(data.userStatistics[0].mainDealerConcededUpgradeAverage, 0);
  changed = applyRound({ ...game, status: 'active' }, { mainDealer: 4, viceDealer: 1, score: 120 }, { id: 'manual', now: 'later' });
  Object.assign(game, finishGame(changed, 'end'), { version: 6, roundCount: 3 });
  data = await collectRecords(call);
  assert.equal(data.games[0].rounds[2].mainDealer, 4);
  assert.equal(data.games[0].rounds[2].mainDealerBefore, null);
  assert.ok(!JSON.stringify(data).includes('hidden-'));
});

test('backup retries a changing database and refuses a missing triggered game', async () => {
  const { call, game } = fixture();
  let indexes = 0;
  const racing = async (action, payload) => {
    const result = await call(action, payload);
    if (action === 'listGames' && ++indexes === 1) return { games: [{ ...game, version: 1 }] };
    return result;
  };
  assert.equal((await collectRecords(racing)).games[0].version, 2);
  assert.equal(indexes, 4);
  await assert.rejects(collectRecords(call, { triggerGame: gameId(99) }), /has not finished/);
});

test('pagination follows every page and a repeated cursor fails instead of truncating data', async () => {
  const { call, game } = fixture();
  const second = { ...game, id: gameId(2) };
  const pages = async (action, payload) => action === 'listGames'
    ? payload.cursor ? { games: [second] } : { games: [game], nextCursor: '1' }
    : action === 'getGame' && payload.gameId === second.id ? { game: second } : call(action, payload);
  assert.equal((await collectRecords(pages)).games.length, 2);
  const broken = async (action, payload) => action === 'listGames' ? { games: [], nextCursor: '1' } : call(action, payload);
  await assert.rejects(collectRecords(broken), /cursor/);
});

test('unchanged snapshots do not create timestamp-only commits and missing records cannot overwrite backups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poker-backup-'));
  try {
    const path = join(dir, 'database.json');
    const data = await collectRecords(fixture().call);
    assert.equal((await writeSnapshot(data, path, { now: () => 'first' })).changed, true);
    const original = await readFile(path, 'utf8');
    assert.equal((await writeSnapshot(data, path, { now: () => 'second' })).changed, false);
    assert.equal(await readFile(path, 'utf8'), original);
    await assert.rejects(writeSnapshot({ ...data, games: [] }, path), /Records disappeared/);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dispatch uses only configured GitHub destination and sends no records or management keys', async () => {
  const { game } = fixture();
  const sent = [];
  const dispatch = createBackupDispatcher({ env: { GITHUB_BACKUP_REPOSITORY: 'owner/records', GITHUB_BACKUP_TOKEN: 'server-only-secret' }, fetchImpl: async (...args) => { sent.push(args); return { ok: true }; } });
  assert.equal((await dispatch(game)).status, 'queued');
  assert.equal(sent[0][0], 'https://api.github.com/repos/owner/records/actions/workflows/backup-records.yml/dispatches');
  assert.equal(sent[0][1].headers.Authorization, 'Bearer server-only-secret');
  const body = JSON.parse(sent[0][1].body);
  assert.deepEqual(body.inputs, { trigger_game: game.id, trigger_version: '2' });
  assert.ok(!JSON.stringify(body).includes('hidden-'));
  assert.equal((await createBackupDispatcher({ env: {} })(game)).status, 'not_configured');
  const failed = createBackupDispatcher({ env: { GITHUB_BACKUP_REPOSITORY: 'owner/records', GITHUB_BACKUP_TOKEN: 'server-only-secret' }, fetchImpl: async () => { throw new Error('secret must not escape'); } });
  assert.deepEqual(await failed(game), { status: 'pending', reason: 'connection' });
});

test('CloudBase export reader can read records but cannot mutate or expose auth tokens in failures', async () => {
  const requests = [];
  const call = createCloudReader({ fetchImpl: async (url, request) => {
    requests.push([url, request]);
    return url.includes('/auth/') ? { ok: true, json: async () => ({ access_token: 'private-token' }) } : { ok: true, json: async () => ({ users: [] }) };
  } });
  assert.deepEqual(await call('listUsers'), { users: [] });
  assert.equal(requests[1][1].headers.Authorization, 'Bearer private-token');
  await assert.rejects(call('finishGame'), /read operations/);
  assert.equal(requests.length, 2);
});

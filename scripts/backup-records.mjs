import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allUserStats, gameStats } from '../public/stats.mjs';

const DEFAULT_ENV = 'poker-score-d4gsbq6k27d6458ca';
const USER_ID = /^u_[a-f0-9]{32}$/;
const GAME_ID = /^g_(?:[a-f0-9]{32}|legacy_[a-f0-9]{32})$/;
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(done => setTimeout(done, ms));

export function createCloudReader({ envId = DEFAULT_ENV, functionName = 'scorekeeper', fetchImpl = fetch } = {}) {
  if (!/^[a-z0-9-]+$/.test(envId) || !/^[a-zA-Z][a-zA-Z0-9_-]+$/.test(functionName)) throw new Error('Invalid CloudBase configuration');
  const base = `https://${envId}.api.tcloudbasegateway.com`;
  let accessToken;
  async function login() {
    const response = await fetchImpl(`${base}/auth/v1/signin/anonymously`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-id': `scorekeeper-github-backup-${envId}` }, body: '{}', signal: AbortSignal.timeout(15000),
    });
    const output = await response.json();
    if (!response.ok || typeof output.access_token !== 'string' || !output.access_token) throw new Error(`CloudBase login failed (HTTP ${response.status})`);
    accessToken = output.access_token;
  }
  return async function call(action, payload = {}) {
    // This reader can never end games, edit scores, or ask for management keys.
    if (!['listUsers', 'listGames', 'getGame'].includes(action)) throw new Error('Backup only supports read operations');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!accessToken) await login();
        const response = await fetchImpl(`${base}/v1/functions/${functionName}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ apiVersion: 2, action, payload, ...(payload.gameId ? { gameId: payload.gameId } : {}) }), signal: AbortSignal.timeout(15000),
        });
        if (response.status === 401) { accessToken = undefined; throw new Error('CloudBase session expired'); }
        if (!response.ok) throw new Error(`CloudBase read failed (HTTP ${response.status})`);
        const output = await response.json();
        if (!output || output.error || output.code) throw new Error('CloudBase rejected the read; no partial backup was written');
        return output;
      } catch (error) {
        if (attempt === 2) throw error;
        await pause(300 * (attempt + 1));
      }
    }
  };
}

async function gameIndex(call) {
  const games = [], cursors = new Set(), ids = new Set();
  let cursor;
  do {
    const page = await call('listGames', { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.games)) throw new Error('Incomplete game index');
    for (const game of page.games) {
      if (!GAME_ID.test(game.id) || ids.has(game.id)) throw new Error('Game index changed during pagination');
      ids.add(game.id); games.push(game);
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('Invalid or repeated backup cursor');
      cursors.add(cursor);
    }
    if (games.length > 1000) throw new Error('Backup record limit exceeded');
  } while (cursor);
  return games.sort((a, b) => a.id.localeCompare(b.id));
}

function cleanUser(user) {
  if (!USER_ID.test(user?.id) || typeof user.name !== 'string') throw new Error('Invalid player record');
  return pick(user, ['id', 'name', 'createdAt']);
}

function cleanGame(game, userIds) {
  if (!GAME_ID.test(game?.id) || !Array.isArray(game.players) || game.players.length !== 5 || !Array.isArray(game.playerIds) || game.playerIds.length !== 5 || new Set(game.playerIds).size !== 5 || game.playerIds.some(id => !userIds.has(id)) || !Array.isArray(game.rounds) || game.roundCount !== game.rounds.length || !['active', 'finished'].includes(game.status)) {
    throw new Error('Incomplete game or missing player; no partial backup was written');
  }
  const clean = pick(game, ['id', 'title', 'playerIds', 'players', 'initialMainDealer', 'mainDealer', 'levels', 'status', 'version', 'createdAt', 'updatedAt', 'finishedAt']);
  clean.rounds = game.rounds.map(round => pick(round, ['id', 'number', 'type', 'wrongPlayer', 'mainDealerBefore', 'mainDealer', 'viceDealer', 'score', 'dealerUpgrade', 'idleUpgrade', 'levelsBefore', 'levelsAfter', 'nextMainDealer', 'createdAt']));
  clean.roundCount = clean.rounds.length;
  clean.statistics = gameStats(clean);
  return clean;
}

const indexSignature = games => JSON.stringify(games.map(game => [game.id, game.version, game.status]));

export async function collectRecords(call, { envId = DEFAULT_ENV, triggerGame = '' } = {}) {
  if (triggerGame && !GAME_ID.test(triggerGame)) throw new Error('Invalid trigger game');
  for (let attempt = 0; attempt < 3; attempt++) {
    const firstUsers = (await call('listUsers')).users;
    if (!Array.isArray(firstUsers)) throw new Error('Incomplete player list');
    const users = firstUsers.map(cleanUser).sort((a, b) => a.id.localeCompare(b.id));
    const userIds = new Set(users.map(user => user.id));
    if (userIds.size !== users.length) throw new Error('Duplicate player IDs');
    const index = await gameIndex(call);
    const games = [];
    for (const summary of index) {
      const detail = await call('getGame', { gameId: summary.id });
      if (detail.game?.id !== summary.id) throw new Error('Unexpected game response');
      games.push(cleanGame(detail.game, userIds));
    }
    const finalIndex = await gameIndex(call);
    const finalUsers = (await call('listUsers')).users;
    if (!Array.isArray(finalUsers)) throw new Error('Incomplete player list');
    if (indexSignature(index) !== indexSignature(games) || indexSignature(index) !== indexSignature(finalIndex) || digest(users) !== digest(finalUsers.map(cleanUser).sort((a, b) => a.id.localeCompare(b.id)))) continue;
    if (triggerGame && !games.some(game => game.id === triggerGame && game.status === 'finished')) throw new Error('Triggered game has not finished in the database');
    return { schemaVersion: 2, source: { environment: envId, collection: 'scorekeeper_rooms', scope: 'v2-profiles-and-games' }, users, games, userStatistics: allUserStats(users, games) };
  }
  throw new Error('Records kept changing during export; retry the backup later');
}

export async function writeSnapshot(records, outputPath, { now = () => new Date().toISOString() } = {}) {
  let previous;
  try { previous = JSON.parse(await readFile(outputPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const dataHash = digest(records);
  if (previous?.dataHash === dataHash) return { changed: false, dataHash };
  if (previous) {
    const ids = new Set(records.games.map(game => game.id));
    const users = new Set(records.users.map(user => user.id));
    if (previous.games?.some(game => !ids.has(game.id)) || previous.users?.some(user => !users.has(user.id))) throw new Error('Records disappeared; refusing to replace the previous complete backup');
  }
  const body = JSON.stringify({ ...records, exportedAt: now(), dataHash }, null, 2) + '\n';
  if (Buffer.byteLength(body) > 80_000_000) throw new Error('Backup exceeds the safe GitHub file size');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body, 'utf8');
  return { changed: true, dataHash };
}

async function main() {
  const envId = process.env.CLOUDBASE_ENV_ID || DEFAULT_ENV;
  const triggerGame = process.env.TRIGGER_GAME || '';
  const outputPath = resolve(process.env.BACKUP_OUTPUT || 'backups/database.json');
  const records = await collectRecords(createCloudReader({ envId }), { envId, triggerGame });
  const result = await writeSnapshot(records, outputPath);
  // Counts and digests are safe in public Actions logs; raw records are not logged.
  console.log(JSON.stringify({ changed: result.changed, users: records.users.length, games: records.games.length, dataHash: result.dataHash }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Database backup failed. The previous backup was preserved; check CloudBase access and retry this workflow.'); process.exitCode = 1; });
}

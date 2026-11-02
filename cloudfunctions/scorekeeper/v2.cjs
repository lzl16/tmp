const { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

// Reuse the existing ADMINONLY collection: all access goes through this service.
const COLLECTION = 'scorekeeper_rooms';
const MAX_ROUNDS = 500;
const MAX_GAME_BYTES = 900_000;
const MAX_LIST_RECORDS = 1000;
const USER_ID = /^u_[a-f0-9]{32}$/;
const GAME_ID = /^g_(?:[a-f0-9]{32}|legacy_[a-f0-9]{32})$/;
const LEGACY_ID = /^[a-f0-9]{32}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
let modulesPromise;

function loadModules() {
  if (!modulesPromise) modulesPromise = Promise.all(['rules', 'stats'].map((name) => {
    const bundled = join(__dirname, `${name}.mjs`);
    const source = existsSync(bundled) ? bundled : join(__dirname, `../../public/${name}.mjs`);
    return import(pathToFileURL(source).href);
  }));
  return modulesPromise;
}

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function documentData(result) { return Array.isArray(result?.data) ? result.data[0] : result?.data; }
function hashKey(key, salt) { return scryptSync(key, salt, 32).toString('hex'); }
function validKey(key, stored, salt) {
  if (typeof key !== 'string' || !KEY.test(key) || typeof stored !== 'string' || !/^[a-f0-9]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(hashKey(key, salt), 'hex'), Buffer.from(stored, 'hex'));
}

function cleanName(value) {
  if (typeof value !== 'string') throw new ApiError('VALIDATION', '玩家昵称必须是文字');
  const name = value.normalize('NFKC').trim();
  if (!name || [...name].length > 20 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw new ApiError('VALIDATION', '玩家昵称须为 1～20 个可见字符');
  }
  return name;
}

function profileFor(name, stamp) {
  name = cleanName(name);
  const normalizedName = name.toLowerCase();
  return {
    id: `u_${createHash('sha256').update(normalizedName, 'utf8').digest('hex').slice(0, 32)}`,
    kind: 'profile', name, normalizedName, createdAt: stamp,
  };
}

function cleanTitle(value) {
  if (value === undefined || value === '') return '五人牌局';
  if (typeof value !== 'string') throw new ApiError('VALIDATION', '牌局名称必须是文字');
  const title = value.trim();
  if (!title || [...title].length > 40 || /[\u0000-\u001f\u007f]/u.test(title)) {
    throw new ApiError('VALIDATION', '牌局名称须为 1～40 个可见字符');
  }
  return title;
}

function publicUser(doc) { return structuredClone({ id: doc.id, name: doc.name, createdAt: doc.createdAt }); }

function publicGame(doc, stats, summary = false) {
  // Explicit allowlist: management hashes and future internal fields never reach clients.
  const game = {
    id: doc.id, title: doc.title, playerIds: doc.playerIds, players: doc.players,
    initialMainDealer: doc.initialMainDealer, mainDealer: doc.mainDealer,
    levels: doc.levels, status: doc.status, version: doc.version,
    createdAt: doc.createdAt, updatedAt: doc.updatedAt, finishedAt: doc.finishedAt,
    roundCount: doc.rounds.length, statistics: stats.gameStats(doc),
  };
  if (!summary) game.rounds = doc.rounds;
  return structuredClone(game);
}

function checkSize(doc) {
  if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > MAX_GAME_BYTES) {
    throw new ApiError('GAME_FULL', '本场记录已满，请结束本场后新开一场');
  }
}

function gameId(event) {
  const id = event.gameId ?? event.payload?.gameId;
  if (typeof id !== 'string' || !GAME_ID.test(id)) throw new ApiError('VALIDATION', '牌局编号无效');
  return id;
}

function requireGame(doc) {
  if (!doc || doc.kind !== 'game') throw new ApiError('NOT_FOUND', '找不到这场牌局');
  return doc;
}

function authorizeGame(doc, key) {
  if (!doc || doc.kind !== 'game' || !validKey(key, doc.writeKeyHash, `${doc.id}:write`)) {
    throw new ApiError('UNAUTHORIZED', '管理密钥无效，请使用本场牌局的管理密钥');
  }
}

async function scanKind(db, kind) {
  const docs = [];
  // No composite index is required; sort the small bounded result in memory.
  // Fetch one extra record so totals are never silently calculated from partial data.
  for (let offset = 0; offset <= MAX_LIST_RECORDS; offset += 100) {
    const result = await db.collection(COLLECTION).where({ kind }).skip(offset).limit(Math.min(100, MAX_LIST_RECORDS + 1 - offset)).get();
    const page = Array.isArray(result?.data) ? result.data : [];
    docs.push(...page);
    if (page.length < Math.min(100, MAX_LIST_RECORDS + 1 - offset)) break;
  }
  if (docs.length > MAX_LIST_RECORDS) throw new ApiError('DATA_LIMIT', '记录数量超过当前查询上限，请联系管理员升级历史查询');
  return docs;
}

function newestFirst(left, right) {
  return String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id));
}

function pagination(payload) {
  const limit = payload.limit ?? 100;
  const cursor = payload.cursor ?? '0';
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof cursor !== 'string' || !/^(0|[1-9]\d{0,3})$/.test(cursor)) {
    throw new ApiError('VALIDATION', '分页参数无效，请刷新后重试');
  }
  return { limit, offset: Number(cursor) };
}

function createHandler({ db, now = () => new Date().toISOString(), randomId = () => randomBytes(16).toString('hex'), randomKey = () => randomBytes(32).toString('base64url'), onGameFinished }) {
  return async function handle(event) {
    try {
      if (!object(event) || event.apiVersion !== 2 || typeof event.action !== 'string') throw new ApiError('VALIDATION', '请求格式无效');
      const payload = event.payload === undefined ? {} : event.payload;
      if (!object(payload)) throw new ApiError('VALIDATION', '请求参数格式无效');
      const [rules, stats] = await loadModules();

      if (event.action === 'listUsers') {
        const users = (await scanKind(db, 'profile')).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
        return { users: users.map(publicUser) };
      }

      if (event.action === 'createUser') {
        const user = profileFor(payload.name, now());
        await db.runTransaction(async (transaction) => {
          const ref = transaction.collection(COLLECTION).doc(user.id);
          if (documentData(await ref.get())) throw new ApiError('DUPLICATE_USER', '这个昵称已存在，请从已有玩家中选择');
          await ref.set(user);
        });
        return { user: publicUser(user) };
      }

      if (event.action === 'listGames') {
        const { limit, offset } = pagination(payload);
        if (payload.status !== undefined && !['active', 'finished', 'all'].includes(payload.status)) throw new ApiError('VALIDATION', '牌局状态无效');
        const all = (await scanKind(db, 'game')).filter((doc) => !payload.status || payload.status === 'all' || doc.status === payload.status).sort(newestFirst);
        const games = all.slice(offset, offset + limit).map((doc) => publicGame(doc, stats, true));
        return offset + limit < all.length ? { games, nextCursor: String(offset + limit) } : { games };
      }

      if (event.action === 'getUserHistory') {
        const id = payload.userId ?? event.userId;
        if (typeof id !== 'string' || !USER_ID.test(id)) throw new ApiError('VALIDATION', '玩家编号无效');
        const user = documentData(await db.collection(COLLECTION).doc(id).get());
        if (!user || user.kind !== 'profile') throw new ApiError('NOT_FOUND', '找不到这位玩家');
        const games = (await scanKind(db, 'game')).filter((doc) => doc.status === 'finished' && doc.playerIds.includes(id)).sort(newestFirst);
        return { user: publicUser(user), stats: stats.userStats(id, games), games: games.map((game) => publicGame(game, stats, true)) };
      }

      if (event.action === 'createGame') {
        if (!Array.isArray(payload.playerIds) || payload.playerIds.length !== 5 || payload.playerIds.some((id) => typeof id !== 'string' || !USER_ID.test(id)) || new Set(payload.playerIds).size !== 5) {
          throw new ApiError('VALIDATION', '请选择五位不同的已有玩家');
        }
        const id = `g_${randomId()}`;
        const writeKey = randomKey();
        const stamp = now();
        let game;
        await db.runTransaction(async (transaction) => {
          const ref = transaction.collection(COLLECTION).doc(id);
          if (documentData(await ref.get())) throw new ApiError('RETRY', '牌局编号冲突，请重试');
          const users = await Promise.all(payload.playerIds.map(async (userId) => documentData(await transaction.collection(COLLECTION).doc(userId).get())));
          if (users.some((user) => !user || user.kind !== 'profile')) throw new ApiError('NOT_FOUND', '有玩家档案不存在，请刷新后重新选择');
          game = {
            ...rules.createGame({ players: users.map((user) => user.name), mainDealer: payload.mainDealer }, { id, now: stamp }),
            kind: 'game', title: cleanTitle(payload.title), playerIds: [...payload.playerIds], version: 0, updatedAt: stamp,
            writeKeyHash: hashKey(writeKey, `${id}:write`),
          };
          checkSize(game);
          await ref.set(game);
        });
        return { game: publicGame(game, stats), writeKey };
      }

      if (event.action === 'importLegacy') {
        const roomId = payload.roomId;
        const legacyKey = payload.writeKey;
        if (typeof roomId !== 'string' || !LEGACY_ID.test(roomId)) throw new ApiError('VALIDATION', '旧牌桌编号无效');
        const cursor = payload.cursor ?? '0';
        if (typeof cursor !== 'string' || !/^(0|[1-9]\d{0,3})$/.test(cursor)) throw new ApiError('VALIDATION', '导入分页参数无效，请重新打开旧版记录');
        const offset = Number(cursor);
        let imported;
        await db.runTransaction(async (transaction) => {
          const legacy = documentData(await transaction.collection(COLLECTION).doc(roomId).get());
          if (!legacy || !Array.isArray(legacy.games) || !validKey(legacyKey, legacy.writeKeyHash, `${roomId}:write`)) {
            throw new ApiError('UNAUTHORIZED', '旧牌桌管理密钥无效，无法导入记录');
          }
          if (offset > legacy.games.length) throw new ApiError('VALIDATION', '导入分页参数无效，请重新打开旧版记录');
          // Free environments hard-limit the function to three seconds. Import one
          // game per invocation; deterministic IDs make retries safe after timeouts.
          const page = legacy.games.slice(offset, offset + 1);
          const userDocs = new Map();
          const writes = [];
          const gameDocs = [];
          const writeKeys = {};
          let created = 0;
          // Read everything before writing, keeping compatibility with transaction SDKs.
          for (const oldGame of page) {
            if (!LEGACY_ID.test(oldGame.id)) throw new ApiError('VALIDATION', '旧牌局编号无效，请先导出备份');
            const names = rules.validatePlayers(oldGame.players);
            const profiles = names.map((name) => profileFor(name, oldGame.createdAt || now()));
            if (new Set(profiles.map((user) => user.id)).size !== 5) throw new ApiError('VALIDATION', '旧牌局中有规范化后相同的昵称，请先修改昵称再导入');
            for (const profile of profiles) {
              if (!userDocs.has(profile.id)) {
                const ref = transaction.collection(COLLECTION).doc(profile.id);
                const existing = documentData(await ref.get());
                if (existing && existing.kind !== 'profile') throw new ApiError('RETRY', '玩家编号冲突，请联系管理员');
                userDocs.set(profile.id, existing || profile);
                if (!existing) writes.push({ ref, doc: profile });
              }
            }
            const id = `g_legacy_${oldGame.id}`;
            const key = createHmac('sha256', legacyKey).update(`scorekeeper:v2:${roomId}:${id}`).digest('base64url');
            const ref = transaction.collection(COLLECTION).doc(id);
            const existing = documentData(await ref.get());
            if (existing) {
              if (existing.kind !== 'game' || existing.sourceLegacyRoomId !== roomId || !validKey(key, existing.writeKeyHash, `${id}:write`)) {
                throw new ApiError('RETRY', '导入牌局编号冲突，请联系管理员');
              }
              gameDocs.push(existing);
            } else {
              const stamp = now();
              const doc = {
                id, kind: 'game', title: cleanTitle(legacy.title),
                playerIds: profiles.map((profile) => profile.id),
                players: profiles.map((profile) => userDocs.get(profile.id).name),
                initialMainDealer: oldGame.initialMainDealer, mainDealer: oldGame.mainDealer,
                levels: structuredClone(oldGame.levels), status: oldGame.status,
                createdAt: oldGame.createdAt, finishedAt: oldGame.finishedAt,
                rounds: structuredClone(oldGame.rounds), updatedAt: stamp, version: 0,
                sourceLegacyRoomId: roomId, writeKeyHash: hashKey(key, `${id}:write`),
              };
              if (doc.rounds.length > MAX_ROUNDS) throw new ApiError('ROUND_LIMIT', '旧牌局记录超过导入上限，请先导出备份');
              if (doc.status === 'finished') doc.statistics = stats.gameStats(doc);
              checkSize(doc);
              gameDocs.push(doc);
              writes.push({ ref, doc });
              created += 1;
            }
            writeKeys[id] = key;
          }
          // CloudBase allows at most 100 document operations per transaction.
          // Include reads and writes; reject before persisting any imported data.
          const plannedOperations = 1 + userDocs.size + page.length + writes.length;
          if (plannedOperations > 100) {
            throw new ApiError('IMPORT_LIMIT', '旧版记录较多，请先导出备份并联系维护者分批导入；原记录未变更');
          }
          for (const { ref, doc } of writes) await ref.set(doc);
          imported = {
            games: gameDocs.map((game) => publicGame(game, stats)), users: [...userDocs.values()].map(publicUser),
            writeKeys, alreadyImported: created === 0, importedCount: created, total: legacy.games.length,
            nextCursor: offset + page.length < legacy.games.length ? String(offset + page.length) : null,
          };
        });
        return imported;
      }

      if (!['getGame', 'verifyGameManager', 'addRound', 'undoRound', 'finishGame'].includes(event.action)) throw new ApiError('VALIDATION', '不支持的操作');
      const id = gameId(event);
      if (event.action === 'getGame' || event.action === 'verifyGameManager') {
        const doc = documentData(await db.collection(COLLECTION).doc(id).get());
        if (event.action === 'verifyGameManager') authorizeGame(doc, event.writeKey);
        else requireGame(doc);
        return { game: publicGame(doc, stats) };
      }

      if (!Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 0) throw new ApiError('VALIDATION', '缺少记录版本，请刷新后重试');
      let result;
      await db.runTransaction(async (transaction) => {
        const ref = transaction.collection(COLLECTION).doc(id);
        const current = documentData(await ref.get());
        authorizeGame(current, event.writeKey);
        if (current.version !== event.expectedVersion) throw new ApiError('STALE_VERSION', '记录已被更新，请刷新后重新操作');
        let doc = structuredClone(current);
        delete doc._id;
        const stamp = now();
        if (event.action === 'addRound') {
          if (doc.rounds.length >= MAX_ROUNDS) throw new ApiError('ROUND_LIMIT', '每场最多记录 500 局，请结束本场后新开一场');
          doc = rules.applyRound(doc, payload, { id: randomId(), now: stamp });
        } else if (event.action === 'undoRound') doc = rules.undoLastRound(doc);
        else {
          doc = rules.finishGame(doc, stamp);
          doc.statistics = stats.gameStats(doc);
        }
        doc.version += 1;
        doc.updatedAt = stamp;
        checkSize(doc);
        await ref.set(doc);
        result = publicGame(doc, stats);
      });
      if (event.action === 'finishGame' && onGameFinished) {
        // The database transaction has committed before contacting GitHub.
        // Backup outages must never turn a successful settlement into a failure.
        let backup;
        try { backup = await onGameFinished(result); }
        catch { backup = { status: 'pending' }; }
        return { game: result, backup };
      }
      return { game: result };
    } catch (error) {
      if (error instanceof ApiError || error?.name === 'RuleError') return { error: { code: error.code, message: error.message } };
      if (String(error?.code).includes('TRANSACTION_CONFLICT')) return { error: { code: 'STALE_VERSION', message: '有人正在更新记录，请刷新后重试' } };
      // Return only a bounded error identifier. SDK messages/stacks can include
      // request details and must never be exposed to visitors.
      const diagnostic = /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code || '') ? error.code :
        ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(error?.name) ? error.name : 'UNKNOWN';
      console.error('scorekeeper v2 failure', diagnostic);
      return { error: { code: 'SERVER_ERROR', message: `云端暂时无法处理，请稍后重试（${diagnostic}）` } };
    }
  };
}

module.exports = { createHandler, COLLECTION, MAX_ROUNDS, MAX_GAME_BYTES, MAX_LIST_RECORDS };

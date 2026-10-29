const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const COLLECTION = 'scorekeeper_rooms';
const MAX_GAMES = 50;
const MAX_ROUNDS = 200;
const MAX_ROOM_BYTES = 900_000;
const ID_PATTERN = /^[a-f0-9]{32}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
let rulesPromise;

function loadRules() {
  if (!rulesPromise) {
    const bundled = join(__dirname, 'rules.mjs');
    const source = existsSync(bundled) ? bundled : join(__dirname, '../../public/rules.mjs');
    rulesPromise = import(pathToFileURL(source).href);
  }
  return rulesPromise;
}

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function hashKey(key, salt) { return scryptSync(key, salt, 32).toString('hex'); }

function validKey(key, stored, salt) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key) || typeof stored !== 'string' || !/^[a-f0-9]{64}$/.test(stored)) return false;
  return timingSafeEqual(Buffer.from(hashKey(key, salt), 'hex'), Buffer.from(stored, 'hex'));
}

function publicRoom(doc) {
  // An allowlist protects secrets even if fields are added to the stored document later.
  return structuredClone({
    id: doc.id,
    title: doc.title,
    version: doc.version,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    games: doc.games,
  });
}

function documentData(result) {
  const data = result?.data;
  // Transaction get() and ordinary get() have used different shapes across SDK versions.
  return Array.isArray(data) ? data[0] : data;
}

function cleanTitle(value) {
  if (value === undefined) return '五人牌局';
  if (typeof value !== 'string') throw new ApiError('VALIDATION', '房间名称必须是文字');
  const clean = value.trim();
  if (!clean || [...clean].length > 40 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new ApiError('VALIDATION', '房间名称须为 1～40 个可见字符');
  }
  return clean;
}

function checkSize(doc) {
  if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > MAX_ROOM_BYTES) {
    throw new ApiError('ROOM_FULL', '房间记录已满，请先导出备份，再创建新房间继续');
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Injectable DB/clock/randomness keeps all authorization and concurrency behavior testable. */
function createHandler({ db, now = () => new Date().toISOString(), randomId = () => randomBytes(16).toString('hex'), randomKey = () => randomBytes(32).toString('base64url') }) {
  return async function handle(event) {
    try {
      if (!object(event) || typeof event.action !== 'string') throw new ApiError('VALIDATION', '请求格式无效');
      const rules = await loadRules();
      const payload = event.payload === undefined ? {} : event.payload;
      if (!object(payload)) throw new ApiError('VALIDATION', '请求参数格式无效');

      if (event.action === 'createRoom') {
        const id = randomId();
        const readKey = randomKey();
        const writeKey = randomKey();
        const stamp = now();
        const doc = {
          id,
          title: cleanTitle(payload.title),
          version: 0,
          createdAt: stamp,
          updatedAt: stamp,
          games: [],
          readKeyHash: hashKey(readKey, `${id}:read`),
          writeKeyHash: hashKey(writeKey, `${id}:write`),
        };
        // Random identifiers are also checked atomically, so even a collision cannot replace a room.
        await db.runTransaction(async (transaction) => {
          const ref = transaction.collection(COLLECTION).doc(id);
          if (documentData(await ref.get())) throw new ApiError('RETRY', '房间编号冲突，请重试');
          await ref.set(doc);
        });
        return { room: publicRoom(doc), readKey, writeKey };
      }

      if (!['getRoom', 'createGame', 'addRound', 'undoRound', 'finishGame'].includes(event.action)) {
        throw new ApiError('VALIDATION', '不支持的操作');
      }
      if (typeof event.roomId !== 'string' || !ID_PATTERN.test(event.roomId)) throw new ApiError('VALIDATION', '房间编号无效');

      const authorize = (doc, write) => {
        // Use the same message for a missing room and wrong key to avoid disclosing room existence.
        if (!doc) throw new ApiError('UNAUTHORIZED', '房间链接或管理权限无效');
        const canWrite = validKey(event.writeKey, doc.writeKeyHash, `${doc.id}:write`);
        if (write ? !canWrite : !canWrite && !validKey(event.readKey, doc.readKeyHash, `${doc.id}:read`)) {
          throw new ApiError('UNAUTHORIZED', write ? '此操作需要房间管理权限' : '房间链接或管理权限无效');
        }
      };

      if (event.action === 'getRoom') {
        const doc = documentData(await db.collection(COLLECTION).doc(event.roomId).get());
        authorize(doc, false);
        return { room: publicRoom(doc) };
      }

      if (!Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 0) {
        throw new ApiError('VALIDATION', '缺少记录版本，请刷新后重试');
      }
      let resultRoom;
      await db.runTransaction(async (transaction) => {
        const ref = transaction.collection(COLLECTION).doc(event.roomId);
        const current = documentData(await ref.get());
        authorize(current, true);
        if (current.version !== event.expectedVersion) {
          throw new ApiError('STALE_VERSION', '记录已被更新，请刷新后重新操作');
        }
        const doc = structuredClone(current);
        delete doc._id;
        const stamp = now();
        if (event.action === 'createGame') {
          if (doc.games.some((game) => game.status === 'active')) throw new ApiError('ACTIVE_GAME', '请先结束当前游戏，再新开一场');
          if (doc.games.length >= MAX_GAMES) throw new ApiError('ROOM_FULL', '每个房间最多保存 50 场，请导出备份后创建新房间');
          doc.games.push(rules.createGame(payload, { id: randomId(), now: stamp }));
        } else {
          if (typeof payload.gameId !== 'string') throw new ApiError('VALIDATION', '缺少游戏编号');
          const index = doc.games.findIndex((game) => game.id === payload.gameId);
          if (index === -1) throw new ApiError('NOT_FOUND', '找不到这场游戏');
          if (event.action === 'addRound') {
            if (doc.games[index].rounds.length >= MAX_ROUNDS) throw new ApiError('ROUND_LIMIT', '每场最多记录 200 局，请结束本场后新开一场');
            doc.games[index] = rules.applyRound(doc.games[index], payload, { id: randomId(), now: stamp });
          } else if (event.action === 'undoRound') {
            doc.games[index] = rules.undoLastRound(doc.games[index]);
          } else {
            doc.games[index] = rules.finishGame(doc.games[index], stamp);
          }
        }
        doc.version += 1;
        doc.updatedAt = stamp;
        checkSize(doc);
        await ref.set(doc);
        resultRoom = publicRoom(doc);
      });
      return { room: resultRoom };
    } catch (error) {
      if (error instanceof ApiError || error?.name === 'RuleError') {
        return { error: { code: error.code, message: error.message } };
      }
      if (String(error?.code).includes('TRANSACTION_CONFLICT')) {
        return { error: { code: 'STALE_VERSION', message: '有人正在更新记录，请刷新后重试' } };
      }
      // Do not return raw SDK errors, credentials, request payloads, or database contents.
      console.error('scorekeeper failure', error?.code || error?.name || 'UNKNOWN');
      return { error: { code: 'SERVER_ERROR', message: '云端暂时无法处理，请稍后重试' } };
    }
  };
}

module.exports = { createHandler, COLLECTION, MAX_GAMES, MAX_ROUNDS, MAX_ROOM_BYTES };

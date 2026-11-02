/** Shared, deterministic rules. Seat indices are zero based and levels are strings. */
export const LEVELS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']);

export class RuleError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message);
    this.name = 'RuleError';
    this.code = code;
  }
}

function seat(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw new RuleError(`${label}必须是五位玩家之一`);
  }
  return value;
}

export function validatePlayers(players) {
  if (!Array.isArray(players) || players.length !== 5) throw new RuleError('请填写五位玩家');
  const names = players.map((name) => {
    if (typeof name !== 'string') throw new RuleError('玩家名字必须是文字');
    const clean = name.trim();
    if (!clean || [...clean].length > 20 || /[\u0000-\u001f\u007f]/u.test(clean)) {
      throw new RuleError('玩家名字须为 1～20 个可见字符');
    }
    return clean;
  });
  if (new Set(names).size !== 5) throw new RuleError('五位玩家的名字不能重复');
  return names;
}

export function scoreOutcome(score) {
  if (!Number.isSafeInteger(score) || score < 0) throw new RuleError('闲家合计分数必须是非负整数');
  if (score === 0) return { dealerUpgrade: 4, idleUpgrade: 0 };
  if (score < 120) return { dealerUpgrade: Math.ceil((120 - score) / 40), idleUpgrade: 0 };
  return { dealerUpgrade: 0, idleUpgrade: Math.floor((score - 120) / 40) };
}

export function rankAfter(rank, steps) {
  const index = LEVELS.indexOf(rank);
  if (index === -1) throw new RuleError('玩家等级无效');
  if (!Number.isSafeInteger(steps) || steps < 0) throw new RuleError('升级数必须是非负整数');
  return LEVELS[(index + (steps % LEVELS.length)) % LEVELS.length];
}

export function settleRound({ mainDealer, viceDealer, score, levels }) {
  seat(mainDealer, '主庄');
  seat(viceDealer, '副庄');
  if (mainDealer === viceDealer) throw new RuleError('主庄和副庄不能是同一人');
  if (!Array.isArray(levels) || levels.length !== 5 || levels.some((rank) => !LEVELS.includes(rank))) {
    throw new RuleError('需要五位玩家的有效等级');
  }
  const { dealerUpgrade, idleUpgrade } = scoreOutcome(score);
  const levelsBefore = [...levels];
  const levelsAfter = levels.map((rank, index) =>
    rankAfter(rank, index === mainDealer || index === viceDealer ? dealerUpgrade : idleUpgrade));
  let nextMainDealer = viceDealer;
  if (dealerUpgrade === 0) {
    for (let offset = 1; offset < 5; offset += 1) {
      const candidate = (mainDealer + offset) % 5;
      if (candidate !== viceDealer) {
        nextMainDealer = candidate;
        break;
      }
    }
  }
  return { mainDealer, viceDealer, score, dealerUpgrade, idleUpgrade, levelsBefore, levelsAfter, nextMainDealer };
}

export function settleWrongRound({ wrongPlayer, levels }) {
  seat(wrongPlayer, '错牌玩家');
  if (!Array.isArray(levels) || levels.length !== 5 || levels.some(rank => !LEVELS.includes(rank))) {
    throw new RuleError('需要五位玩家的有效等级');
  }
  return {
    type: 'wrong', wrongPlayer, score: null, viceDealer: null,
    levelsBefore: [...levels],
    levelsAfter: levels.map((rank, index) => rankAfter(rank, index === wrongPlayer ? 0 : 1)),
    nextMainDealer: null,
  };
}

export function createGame({ players, mainDealer }, { id, now } = {}) {
  const cleanPlayers = validatePlayers(players);
  seat(mainDealer, '首局主庄');
  if (typeof id !== 'string' || !id || typeof now !== 'string' || !now) {
    throw new RuleError('缺少牌局编号或创建时间');
  }
  return {
    id,
    players: cleanPlayers,
    initialMainDealer: mainDealer,
    mainDealer,
    levels: Array(5).fill('2'),
    status: 'active',
    createdAt: now,
    finishedAt: null,
    rounds: [],
  };
}

function requireActive(game) {
  if (!game || game.status !== 'active') throw new RuleError('这场游戏已经结束，不能继续记分', 'GAME_FINISHED');
}

export function applyRound(game, payload, { id, now } = {}) {
  requireActive(game);
  if (typeof id !== 'string' || !id || typeof now !== 'string' || !now) {
    throw new RuleError('缺少记录编号或创建时间');
  }
  const type = payload.type ?? 'score';
  if (!['score', 'wrong'].includes(type)) throw new RuleError('请选择正常得分或错牌');
  let result;
  if (type === 'wrong') {
    result = { ...settleWrongRound({ wrongPlayer: payload.wrongPlayer, levels: game.levels }), mainDealer: game.mainDealer };
  } else {
    const mainDealer = game.mainDealer === null ? payload.mainDealer : game.mainDealer;
    result = { type, ...settleRound({ mainDealer, viceDealer: payload.viceDealer, score: payload.score, levels: game.levels }) };
  }
  const round = { id, number: game.rounds.length + 1, ...result, mainDealerBefore: game.mainDealer, createdAt: now };
  return { ...game, mainDealer: result.nextMainDealer, levels: result.levelsAfter, rounds: [...game.rounds, round] };
}

export function undoLastRound(game) {
  requireActive(game);
  if (!game.rounds.length) throw new RuleError('还没有可以撤销的记录', 'NO_ROUNDS');
  const last = game.rounds[game.rounds.length - 1];
  const mainDealer = Object.hasOwn(last, 'mainDealerBefore') ? last.mainDealerBefore : last.mainDealer;
  return { ...game, mainDealer, levels: [...last.levelsBefore], rounds: game.rounds.slice(0, -1) };
}

export function finishGame(game, now) {
  requireActive(game);
  if (typeof now !== 'string' || !now) throw new RuleError('缺少结束时间');
  return { ...game, status: 'finished', finishedAt: now };
}

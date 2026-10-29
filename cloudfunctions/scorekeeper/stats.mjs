import { rankAfter, scoreOutcome } from './rules.mjs';

const average = (total, count) => count ? total / count : null;

/**
 * Scores belong to the whole idle team. Each participant receives that team's
 * score in their own role statistics; it is never divided among teammates.
 * Levels wrap, so cumulative upgrades are calculated from round settlements.
 */
export function gameStats(game) {
  const rounds = game.rounds || [];
  const rows = game.players.map((name, seat) => ({
    userId: game.playerIds?.[seat] || name,
    name,
    seat,
    rank: null,
    totalUpgrade: 0,
    mainDealerBonus: rounds.length && seat === game.mainDealer ? 0.5 : 0,
    dealerRounds: 0,
    idleRounds: 0,
    dealerScoreTotal: 0,
    idleScoreTotal: 0,
    dealerAverage: null,
    idleAverage: null,
    finalLevel: '2',
  }));

  for (const round of rounds) {
    const fallback = round.dealerUpgrade == null || round.idleUpgrade == null
      ? scoreOutcome(round.score) : null;
    const dealerUpgrade = round.dealerUpgrade ?? fallback.dealerUpgrade;
    const idleUpgrade = round.idleUpgrade ?? fallback.idleUpgrade;
    for (const row of rows) {
      if (row.seat === round.mainDealer || row.seat === round.viceDealer) {
        row.dealerRounds += 1;
        row.dealerScoreTotal += round.score;
        row.totalUpgrade += dealerUpgrade;
      } else {
        row.idleRounds += 1;
        row.idleScoreTotal += round.score;
        row.totalUpgrade += idleUpgrade;
      }
    }
  }

  for (const row of rows) {
    row.dealerAverage = average(row.dealerScoreTotal, row.dealerRounds);
    row.idleAverage = average(row.idleScoreTotal, row.idleRounds);
    row.finalLevel = game.levels?.[row.seat]
      ?? rounds.at(-1)?.levelsAfter?.[row.seat]
      ?? rankAfter('2', row.totalUpgrade);
  }

  const weight = row => row.totalUpgrade * 2 + row.mainDealerBonus * 2;
  rows.sort((a, b) => weight(b) - weight(a) || a.seat - b.seat);
  if (rounds.length) {
    for (let index = 0; index < rows.length; index += 1) {
      rows[index].rank = index && weight(rows[index]) === weight(rows[index - 1])
        ? rows[index - 1].rank : index + 1;
    }
  }
  return rows;
}

/**
 * Lifetime results include completed games with at least one saved round.
 * Empty games have no ranking, while active games remain provisional.
 * Role averages are weighted by rounds; average rank is weighted by games.
 * Profile IDs preserve identity even when two profiles share a nickname.
 */
export function userStats(userId, games) {
  const history = games
    .filter(game => game.status === 'finished' && game.rounds?.length)
    .flatMap(game => {
      const row = gameStats(game).find(result => result.userId === userId);
      return row ? [{
        gameId: game.id,
        title: game.title || '牌局',
        createdAt: game.createdAt,
        finishedAt: game.finishedAt,
        ...row,
      }] : [];
    })
    .sort((a, b) => String(b.finishedAt || b.createdAt || '')
      .localeCompare(String(a.finishedAt || a.createdAt || '')));

  const result = {
    userId,
    completedGames: history.length,
    dealerRounds: 0,
    idleRounds: 0,
    dealerScoreTotal: 0,
    idleScoreTotal: 0,
    dealerAverage: null,
    idleAverage: null,
    averageRank: null,
    totalUpgrade: 0,
    history,
  };
  for (const row of history) {
    result.dealerRounds += row.dealerRounds;
    result.idleRounds += row.idleRounds;
    result.dealerScoreTotal += row.dealerScoreTotal;
    result.idleScoreTotal += row.idleScoreTotal;
    result.totalUpgrade += row.totalUpgrade;
  }
  result.dealerAverage = average(result.dealerScoreTotal, result.dealerRounds);
  result.idleAverage = average(result.idleScoreTotal, result.idleRounds);
  result.averageRank = average(history.reduce((sum, row) => sum + row.rank, 0), history.length);
  return result;
}

export function allUserStats(users, games) {
  return users.map(user => ({ ...userStats(user.id, games), name: user.name }));
}

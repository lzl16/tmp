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
    mainDealerRounds: 0,
    viceDealerRounds: 0,
    idleRounds: 0,
    wrongRounds: 0,
    mainDealerUpgradeTotal: 0,
    viceDealerUpgradeTotal: 0,
    idleConcededUpgradeTotal: 0,
    mainDealerUpgradeAverage: null,
    viceDealerUpgradeAverage: null,
    idleConcededUpgradeAverage: null,
    mainDealerConcededUpgradeTotal: 0,
    viceDealerConcededUpgradeTotal: 0,
    idleUpgradeTotal: 0,
    mainDealerConcededUpgradeAverage: null,
    viceDealerConcededUpgradeAverage: null,
    idleUpgradeAverage: null,
    mainDealerScoreTotal: 0,
    viceDealerScoreTotal: 0,
    idleScoreTotal: 0,
    mainDealerAverage: null,
    viceDealerAverage: null,
    idleAverage: null,
    finalLevel: '2',
  }));

  for (const round of rounds) {
    if (round.type === 'wrong') {
      for (const row of rows) {
        if (row.seat === round.wrongPlayer) row.wrongRounds += 1;
        else row.totalUpgrade += 1;
      }
      continue;
    }
    const fallback = round.dealerUpgrade == null || round.idleUpgrade == null
      ? scoreOutcome(round.score) : null;
    const dealerUpgrade = round.dealerUpgrade ?? fallback.dealerUpgrade;
    const idleUpgrade = round.idleUpgrade ?? fallback.idleUpgrade;
    for (const row of rows) {
      if (row.seat === round.mainDealer || row.seat === round.viceDealer) {
        const role = row.seat === round.mainDealer ? 'mainDealer' : 'viceDealer';
        row[role + 'Rounds'] += 1;
        row[role + 'ScoreTotal'] += round.score;
        row[role + 'ConcededUpgradeTotal'] += idleUpgrade;
        row[role + 'UpgradeTotal'] += dealerUpgrade;
        row.totalUpgrade += dealerUpgrade;
      } else {
        row.idleRounds += 1;
        row.idleScoreTotal += round.score;
        row.idleUpgradeTotal += idleUpgrade;
        row.idleConcededUpgradeTotal += dealerUpgrade;
        row.totalUpgrade += idleUpgrade;
      }
    }
  }

  for (const row of rows) {
    row.mainDealerUpgradeAverage = average(row.mainDealerUpgradeTotal, row.mainDealerRounds);
    row.viceDealerUpgradeAverage = average(row.viceDealerUpgradeTotal, row.viceDealerRounds);
    row.idleConcededUpgradeAverage = average(row.idleConcededUpgradeTotal, row.idleRounds);
    row.mainDealerConcededUpgradeAverage = average(row.mainDealerConcededUpgradeTotal, row.mainDealerRounds);
    row.viceDealerConcededUpgradeAverage = average(row.viceDealerConcededUpgradeTotal, row.viceDealerRounds);
    row.idleUpgradeAverage = average(row.idleUpgradeTotal, row.idleRounds);
    row.mainDealerAverage = average(row.mainDealerScoreTotal, row.mainDealerRounds);
    row.viceDealerAverage = average(row.viceDealerScoreTotal, row.viceDealerRounds);
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
    mainDealerRounds: 0,
    viceDealerRounds: 0,
    idleRounds: 0,
    wrongRounds: 0,
    mainDealerUpgradeTotal: 0,
    viceDealerUpgradeTotal: 0,
    idleConcededUpgradeTotal: 0,
    mainDealerUpgradeAverage: null,
    viceDealerUpgradeAverage: null,
    idleConcededUpgradeAverage: null,
    mainDealerConcededUpgradeTotal: 0,
    viceDealerConcededUpgradeTotal: 0,
    idleUpgradeTotal: 0,
    mainDealerConcededUpgradeAverage: null,
    viceDealerConcededUpgradeAverage: null,
    idleUpgradeAverage: null,
    mainDealerScoreTotal: 0,
    viceDealerScoreTotal: 0,
    idleScoreTotal: 0,
    mainDealerAverage: null,
    viceDealerAverage: null,
    idleAverage: null,
    averageRank: null,
    totalUpgrade: 0,
    history,
  };
  for (const row of history) {
    result.mainDealerRounds += row.mainDealerRounds;
    result.viceDealerRounds += row.viceDealerRounds;
    result.idleRounds += row.idleRounds;
    result.wrongRounds += row.wrongRounds;
    result.mainDealerUpgradeTotal += row.mainDealerUpgradeTotal;
    result.viceDealerUpgradeTotal += row.viceDealerUpgradeTotal;
    result.idleConcededUpgradeTotal += row.idleConcededUpgradeTotal;
    result.mainDealerConcededUpgradeTotal += row.mainDealerConcededUpgradeTotal;
    result.viceDealerConcededUpgradeTotal += row.viceDealerConcededUpgradeTotal;
    result.idleUpgradeTotal += row.idleUpgradeTotal;
    result.mainDealerScoreTotal += row.mainDealerScoreTotal;
    result.viceDealerScoreTotal += row.viceDealerScoreTotal;
    result.idleScoreTotal += row.idleScoreTotal;
    result.totalUpgrade += row.totalUpgrade;
  }
  result.mainDealerUpgradeAverage = average(result.mainDealerUpgradeTotal, result.mainDealerRounds);
  result.viceDealerUpgradeAverage = average(result.viceDealerUpgradeTotal, result.viceDealerRounds);
  result.idleConcededUpgradeAverage = average(result.idleConcededUpgradeTotal, result.idleRounds);
  result.mainDealerConcededUpgradeAverage = average(result.mainDealerConcededUpgradeTotal, result.mainDealerRounds);
  result.viceDealerConcededUpgradeAverage = average(result.viceDealerConcededUpgradeTotal, result.viceDealerRounds);
  result.idleUpgradeAverage = average(result.idleUpgradeTotal, result.idleRounds);
  result.mainDealerAverage = average(result.mainDealerScoreTotal, result.mainDealerRounds);
  result.viceDealerAverage = average(result.viceDealerScoreTotal, result.viceDealerRounds);
  result.idleAverage = average(result.idleScoreTotal, result.idleRounds);
  result.averageRank = average(history.reduce((sum, row) => sum + row.rank, 0), history.length);
  return result;
}

export function allUserStats(users, games) {
  return users.map(user => ({ ...userStats(user.id, games), name: user.name }));
}

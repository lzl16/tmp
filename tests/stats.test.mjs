import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRound, createGame, finishGame, undoLastRound } from '../public/rules.mjs';
import { allUserStats, gameStats, userStats } from '../public/stats.mjs';

const names = ['阿东', '阿南', '阿西', '阿北', '阿中'];
const playerIds = ['east', 'south', 'west', 'north', 'middle'];
const start = (id = 'game-1') => ({
  ...createGame({ players: names, mainDealer: 0 }, { id, now: '2026-10-29T09:00:00.000Z' }),
  playerIds,
  title: id,
});
const round = (game, viceDealer, score) => applyRound(game, { viceDealer, score }, {
  id: `${game.id}-${game.rounds.length + 1}`,
  now: '2026-10-29T09:01:00.000Z',
});
const complete = (game, time = '2026-10-29T10:00:00.000Z') => finishGame(game, time);
const bySeat = rows => [...rows].sort((a, b) => a.seat - b.seat);

test('main and vice appearances and averages are separated while idle players receive the collective score', () => {
  const game = round(start(), 1, 200);
  const rows = bySeat(gameStats(game));
  assert.deepEqual(rows.map(row => row.mainDealerRounds), [1, 0, 0, 0, 0]);
  assert.deepEqual(rows.map(row => row.viceDealerRounds), [0, 1, 0, 0, 0]);
  assert.deepEqual(rows.map(row => row.idleRounds), [0, 0, 1, 1, 1]);
  assert.deepEqual(rows.map(row => row.mainDealerScoreTotal), [200, 0, 0, 0, 0]);
  assert.deepEqual(rows.map(row => row.viceDealerScoreTotal), [0, 200, 0, 0, 0]);
  assert.deepEqual(rows.map(row => row.idleScoreTotal), [0, 0, 200, 200, 200]);
  assert.deepEqual(rows.map(row => row.mainDealerAverage), [200, null, null, null, null]);
  assert.deepEqual(rows.map(row => row.viceDealerAverage), [null, 200, null, null, null]);
  assert.deepEqual(rows.map(row => row.idleAverage), [null, null, 200, 200, 200]);
  assert.deepEqual(rows.map(row => row.totalUpgrade), [0, 0, 2, 2, 2]);
  assert.deepEqual(rows.map(row => row.userId), playerIds);
});

test('missing settlement fields are derived using all score boundaries, including zero bonus', () => {
  for (const [score, dealerUpgrade, idleUpgrade] of [
    [0, 4, 0], [1, 3, 0], [39, 3, 0], [40, 2, 0], [79, 2, 0],
    [80, 1, 0], [119, 1, 0], [120, 0, 0], [159, 0, 0], [160, 0, 1], [200, 0, 2],
  ]) {
    const game = round(start(), 1, score);
    delete game.rounds[0].dealerUpgrade;
    delete game.rounds[0].idleUpgrade;
    assert.deepEqual(bySeat(gameStats(game)).map(row => row.totalUpgrade),
      [dealerUpgrade, dealerUpgrade, idleUpgrade, idleUpgrade, idleUpgrade], `score ${score}`);
  }
});

test('stored cumulative upgrades survive complete level cycles and never use the wrapped final rank', () => {
  let game = start();
  for (let index = 0; index < 4; index += 1) game = round(game, game.mainDealer === 0 ? 1 : 0, 0);
  const rows = bySeat(gameStats(game));
  assert.equal(rows[0].totalUpgrade, 16);
  assert.equal(rows[1].totalUpgrade, 16);
  assert.equal(rows[0].finalLevel, '5');
  assert.equal(rows[1].finalLevel, '5');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].rank, 2);
});

test('the ending displayed main dealer wins tied upgrades by half a level, without adding to upgrade totals', () => {
  const game = round(start(), 1, 120);
  const rows = gameStats(game);
  assert.equal(game.mainDealer, 2);
  assert.equal(rows[0].seat, 2);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].mainDealerBonus, 0.5);
  assert.ok(rows.every(row => row.totalUpgrade === 0));
  assert.deepEqual(bySeat(rows).map(row => row.rank), [2, 2, 1, 2, 2]);
  assert.equal(rows.find(row => row.seat === game.rounds[0].mainDealer).mainDealerBonus, 0);
});

test('competition ranks skip occupied places and ties keep seat order', () => {
  // Seats 0, 1 and 2 each gain 2 levels across three dealer wins.
  // Seat 3 is ending main dealer with 0 upgrades, so it follows that tie in fourth place.
  const game = {
    ...start(),
    mainDealer: 3,
    rounds: [[0, 1], [1, 2], [2, 0]].map(([mainDealer, viceDealer]) => ({
      mainDealer, viceDealer, score: 80, dealerUpgrade: 1, idleUpgrade: 0,
    })),
    levels: ['4', '4', '4', '2', '2'],
  };
  const rows = gameStats(game);
  assert.deepEqual(rows.map(row => row.seat), [0, 1, 2, 3, 4]);
  assert.deepEqual(rows.map(row => row.rank), [1, 1, 1, 4, 5]);
  assert.deepEqual(rows.map(row => row.totalUpgrade), [2, 2, 2, 0, 0]);
});

test('role averages are weighted by rounds across games while ranks are averaged once per game', () => {
  const first = complete(round(start('one'), 1, 0));
  let second = start('two');
  second = round(second, 1, 120);
  second = round(second, 0, 240);
  second = round(second, 4, 160);
  second = complete(second, '2026-10-30T10:00:00.000Z');
  const stats = userStats('east', [first, second]);
  assert.equal(stats.completedGames, 2);
  assert.equal(stats.mainDealerRounds, 2);
  assert.equal(stats.mainDealerScoreTotal, 120);
  assert.equal(stats.mainDealerAverage, 60);
  assert.equal(stats.viceDealerRounds, 1);
  assert.equal(stats.viceDealerScoreTotal, 240);
  assert.equal(stats.viceDealerAverage, 240);
  assert.equal(stats.idleRounds, 1);
  assert.equal(stats.idleScoreTotal, 160);
  assert.equal(stats.idleAverage, 160);
  assert.equal(stats.averageRank, (userStats('east', [first]).averageRank + userStats('east', [second]).averageRank) / 2);
  assert.equal(stats.totalUpgrade, 5);
  assert.deepEqual(stats.history.map(row => row.gameId), ['two', 'one']);
  assert.equal(stats.history[0].title, 'two');
});

test('unfinished and zero-round games are excluded from lifetime results and undefined averages remain null', () => {
  const empty = complete(start('empty'));
  const active = round(start('active'), 1, 0);
  assert.ok(gameStats(empty).every(row => row.rank === null && row.mainDealerBonus === 0));
  const stats = userStats('east', [empty, active]);
  assert.equal(stats.completedGames, 0);
  assert.equal(stats.mainDealerRounds, 0);
  assert.equal(stats.idleRounds, 0);
  assert.equal(stats.mainDealerAverage, null);
  assert.equal(stats.idleAverage, null);
  assert.equal(stats.averageRank, null);
  assert.deepEqual(stats.history, []);
  assert.equal(userStats('unknown', [complete(active)]).completedGames, 0);
});

test('profiles with equal nicknames stay separate and names are used only for games without profile IDs', () => {
  const first = complete(round(start('one'), 1, 0));
  const second = complete({ ...round(start('two'), 1, 200), playerIds: ['other-east', ...playerIds.slice(1)] });
  assert.equal(userStats('east', [first, second]).completedGames, 1);
  assert.equal(userStats('other-east', [first, second]).completedGames, 1);
  assert.equal(userStats(names[0], [first, second]).completedGames, 0);
  const legacy = { ...first };
  delete legacy.playerIds;
  assert.equal(userStats(names[0], [legacy]).completedGames, 1);
  const results = allUserStats([{ id: 'east', name: names[0] }, { id: 'other-east', name: names[0] }], [first, second]);
  assert.equal(results[0].name, results[1].name);
  assert.notEqual(results[0].mainDealerAverage, results[1].mainDealerAverage);
});

test('statistics do not mutate recorded games', () => {
  const game = complete(round(start(), 1, 35));
  const before = structuredClone(game);
  gameStats(game);
  userStats('east', [game]);
  assert.deepEqual(game, before);
});

test('wrong rounds affect upgrades and rank but never role counts or score denominators', () => {
  const wrong = applyRound(start(), { type: 'wrong', wrongPlayer: 0 }, { id: 'wrong', now: 'then' });
  const rows = bySeat(gameStats(complete(wrong)));
  assert.deepEqual(rows.map(row => row.totalUpgrade), [0, 1, 1, 1, 1]);
  assert.deepEqual(rows.map(row => row.rank), [5, 1, 1, 1, 1]);
  assert.ok(rows.every(row => row.mainDealerBonus === 0 && row.mainDealerRounds === 0 && row.viceDealerRounds === 0 && row.idleRounds === 0 && row.mainDealerAverage === null && row.viceDealerAverage === null && row.idleAverage === null));
  const scored = applyRound(wrong, { mainDealer: 4, viceDealer: 0, score: 80 }, { id: 'score', now: 'later' });
  const stats = userStats('east', [complete(scored)]);
  assert.equal(stats.completedGames, 1);
  assert.equal(stats.totalUpgrade, 1);
  assert.equal(stats.mainDealerRounds, 0);
  assert.equal(stats.viceDealerRounds, 1);
  assert.equal(stats.viceDealerAverage, 80);
  assert.equal(stats.idleAverage, null);
});

test('conceded upgrades count idle team levels, include zero outcomes and exclude wrong-play penalties', () => {
  let game = start('mixed');
  for (const [vice, score] of [[1, 200], [0, 120], [0, 240], [1, 80], [2, 160]]) game = round(game, vice, score);
  // Seat 0: one main round conceding 2, two vice rounds conceding 0 and 3,
  // and two idle rounds upgrading 0 and 1. Never multiply idle upgrades by 3.
  game = applyRound(game, { type: 'wrong', wrongPlayer: 0 }, { id: 'wrong-0', now: 'then' });
  game = applyRound(game, { type: 'wrong', wrongPlayer: 1 }, { id: 'wrong-1', now: 'later' });
  const row = gameStats(game).find(row => row.seat === 0);
  assert.equal(row.wrongRounds, 1);
  assert.equal(row.mainDealerConcededUpgradeTotal, 2);
  assert.equal(row.mainDealerConcededUpgradeAverage, 2);
  assert.equal(row.mainDealerUpgradeAverage, 0);
  assert.equal(row.viceDealerConcededUpgradeTotal, 3);
  assert.equal(row.viceDealerConcededUpgradeAverage, 1.5);
  assert.equal(row.viceDealerUpgradeAverage, 0);
  assert.equal(row.idleUpgradeTotal, 1);
  assert.equal(row.idleUpgradeAverage, 0.5);
  assert.equal(row.idleConcededUpgradeTotal, 1);
  assert.equal(row.idleConcededUpgradeAverage, 0.5);
  assert.equal(row.totalUpgrade, 2, 'the extra wrong-play award still contributes to ranking');
  assert.equal(gameStats(game).reduce((sum, row) => sum + row.wrongRounds, 0), 2);
  const beforeWrong = undoLastRound(undoLastRound(game));
  assert.ok(gameStats(beforeWrong).every(row => row.wrongRounds === 0));
  const legacy = structuredClone(game);
  for (const round of legacy.rounds) { delete round.dealerUpgrade; delete round.idleUpgrade; }
  assert.deepEqual(gameStats(legacy), gameStats(game), 'old score-only records derive the same upgrade means');
});

test('career upgrade averages use all role rounds, while wrong-only games have no role averages', () => {
  let first = start('first');
  for (const [vice, score] of [[1, 200], [0, 120], [0, 240]]) first = round(first, vice, score);
  let second = start('second');
  for (const vice of [1, 0, 1]) second = round(second, vice, 0);
  const wrong = applyRound(start('wrong'), { type: 'wrong', wrongPlayer: 0 }, { id: 'wrong', now: 'then' });
  const stats = userStats('east', [complete(first), complete(second), complete(wrong), round(start('active'), 1, 400)]);
  assert.equal(stats.wrongRounds, 1);
  assert.equal(stats.completedGames, 3);
  assert.equal(stats.mainDealerConcededUpgradeAverage, 2 / 3);
  assert.equal(stats.viceDealerConcededUpgradeAverage, 1);
  assert.equal(stats.mainDealerUpgradeTotal, 8);
  assert.equal(stats.mainDealerUpgradeAverage, 8 / 3);
  assert.equal(stats.viceDealerUpgradeTotal, 4);
  assert.equal(stats.viceDealerUpgradeAverage, 4 / 3);
  assert.equal(stats.idleConcededUpgradeAverage, null);
  assert.equal(stats.idleUpgradeAverage, null);
  const wrongOnly = userStats('east', [complete(wrong)]);
  assert.equal(wrongOnly.wrongRounds, 1);
  assert.equal(wrongOnly.mainDealerConcededUpgradeAverage, null);
  assert.equal(wrongOnly.viceDealerConcededUpgradeAverage, null);
  assert.equal(wrongOnly.idleUpgradeAverage, null);
  assert.equal(wrongOnly.mainDealerUpgradeAverage, null);
  assert.equal(wrongOnly.viceDealerUpgradeAverage, null);
  assert.equal(wrongOnly.idleConcededUpgradeAverage, null);
});

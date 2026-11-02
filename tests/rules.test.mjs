import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, scoreOutcome, rankAfter, settleRound, createGame, applyRound, undoLastRound, finishGame } from '../public/rules.mjs';

const names = ['阿东', '阿南', '阿西', '阿北', '阿中'];
const start = () => createGame({ players: names, mainDealer: 0 }, { id: 'game-1', now: '2026-10-29T09:00:00.000Z' });

test('all scoring thresholds including zero bonus and user examples', () => {
  const cases = [
    [0, 4, 0], [1, 3, 0], [35, 3, 0], [39, 3, 0], [40, 2, 0], [79, 2, 0],
    [80, 1, 0], [115, 1, 0], [119, 1, 0], [120, 0, 0], [155, 0, 0], [159, 0, 0],
    [160, 0, 1], [199, 0, 1], [200, 0, 2], [239, 0, 2], [240, 0, 3],
  ];
  for (const [score, dealerUpgrade, idleUpgrade] of cases) {
    assert.deepEqual(scoreOutcome(score), { dealerUpgrade, idleUpgrade }, `score ${score}`);
  }
});

test('invalid scores cannot be coerced to zero or accepted as fractional counts', () => {
  for (const score of ['', '120', null, undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => scoreOutcome(score), /非负整数/);
  }
});

test('each rank cycles through A to 2, including multiple full cycles', () => {
  assert.equal(LEVELS.length, 13);
  assert.equal(rankAfter('K', 1), 'A');
  assert.equal(rankAfter('A', 1), '2');
  assert.equal(rankAfter('Q', 4), '3');
  assert.equal(rankAfter('2', 30), '6');
  assert.throws(() => rankAfter('1', 1));
  assert.throws(() => rankAfter('A', -1));
});

test('dealer win upgrades both dealers independently and makes vice dealer next main', () => {
  const result = settleRound({ mainDealer: 4, viceDealer: 1, score: 0, levels: ['2', 'K', '3', '4', 'A'] });
  assert.deepEqual(result.levelsAfter, ['2', '4', '3', '4', '5']);
  assert.equal(result.nextMainDealer, 1);
  assert.deepEqual(result.levelsBefore, ['2', 'K', '3', '4', 'A']);
});

test('no dealer upgrade chooses first idle clockwise, skips vice and wraps', () => {
  const levels = Array(5).fill('2');
  for (const score of [120, 159, 160, 240]) {
    assert.equal(settleRound({ mainDealer: 4, viceDealer: 0, score, levels }).nextMainDealer, 1);
    assert.equal(settleRound({ mainDealer: 1, viceDealer: 4, score, levels }).nextMainDealer, 2);
  }
});

test('idle win upgrades all three idle players only', () => {
  const result = settleRound({ mainDealer: 1, viceDealer: 3, score: 240, levels: ['A', 'Q', 'K', 'J', '2'] });
  assert.deepEqual(result.levelsAfter, ['4', 'Q', '3', 'J', '5']);
  assert.equal(result.idleUpgrade, 3);
});

test('dealer seats and levels must be valid', () => {
  const base = { mainDealer: 0, viceDealer: 1, score: 120, levels: Array(5).fill('2') };
  for (const bad of [{ mainDealer: -1 }, { viceDealer: 5 }, { viceDealer: 0 }, { levels: ['2'] }, { levels: [2, 2, 2, 2, 2] }]) {
    assert.throws(() => settleRound({ ...base, ...bad }));
  }
});

test('new games require five distinct trimmed names and always restart everyone at 2', () => {
  const game = start();
  assert.deepEqual(game.levels, Array(5).fill('2'));
  assert.equal(game.mainDealer, 0);
  assert.equal(game.status, 'active');
  for (const players of [names.slice(1), ['同名', ' 同名 ', '三', '四', '五'], ['', '二', '三', '四', '五'], [1, '二', '三', '四', '五']]) {
    assert.throws(() => createGame({ players, mainDealer: 0 }, { id: 'game', now: 'now' }));
  }
});

test('round append and undo restore both levels and main dealer without mutating past data', () => {
  const initial = start();
  const one = applyRound(initial, { viceDealer: 2, score: 35 }, { id: 'one', now: 'then' });
  const two = applyRound(one, { viceDealer: 3, score: 200 }, { id: 'two', now: 'later' });
  assert.equal(initial.rounds.length, 0);
  assert.equal(one.rounds.length, 1);
  assert.equal(two.rounds[1].number, 2);
  const undone = undoLastRound(two);
  assert.deepEqual(undone, one);
  assert.deepEqual(undoLastRound(undone), initial);
  assert.throws(() => undoLastRound(initial), /没有可以撤销/);
});

test('finished games preserve records and reject append or undo', () => {
  const one = applyRound(start(), { viceDealer: 2, score: 80 }, { id: 'one', now: 'then' });
  const finished = finishGame(one, 'end');
  assert.equal(finished.finishedAt, 'end');
  assert.deepEqual(finished.rounds, one.rounds);
  assert.throws(() => applyRound(finished, { viceDealer: 2, score: 120 }, { id: 'two', now: 'later' }), /已经结束/);
  assert.throws(() => undoLastRound(finished), /已经结束/);
});

test('wrong play upgrades exactly the other four players, wraps A and can be undone', () => {
  for (let wrongPlayer = 0; wrongPlayer < 5; wrongPlayer++) {
    const initial = { ...start(), levels: ['A', 'K', '2', '9', '10'] };
    const next = applyRound(initial, { type: 'wrong', wrongPlayer, levels: Array(5).fill('A') }, { id: 'wrong', now: 'then' });
    assert.deepEqual(next.levels, initial.levels.map((rank, seat) => rankAfter(rank, seat === wrongPlayer ? 0 : 1)));
    assert.equal(next.mainDealer, null);
    assert.equal(next.rounds[0].score, null);
    assert.equal(next.rounds[0].wrongPlayer, wrongPlayer);
    assert.deepEqual(undoLastRound(next), initial);
  }
  for (const wrongPlayer of [-1, 5, '0', null, undefined]) assert.throws(() => applyRound(start(), { type: 'wrong', wrongPlayer }, { id: 'bad', now: 'then' }));
  assert.throws(() => applyRound(start(), { type: 'other' }, { id: 'bad', now: 'then' }));
});

test('after wrong play both dealers are chosen manually once and undo restores pending selection', () => {
  const initial = start();
  const wrong = applyRound(initial, { type: 'wrong', wrongPlayer: 2 }, { id: 'wrong', now: 'then' });
  for (const payload of [{ viceDealer: 1, score: 80 }, { mainDealer: 4, viceDealer: 4, score: 80 }]) {
    assert.throws(() => applyRound(wrong, payload, { id: 'invalid', now: 'later' }));
  }
  const normal = applyRound(wrong, { mainDealer: 4, viceDealer: 1, score: 80 }, { id: 'normal', now: 'later' });
  assert.equal(normal.rounds[1].mainDealer, 4);
  assert.equal(normal.rounds[1].viceDealer, 1);
  assert.equal(normal.mainDealer, 1);
  assert.deepEqual(undoLastRound(normal), wrong);
  const resumed = applyRound(normal, { mainDealer: 4, viceDealer: 2, score: 120 }, { id: 'resumed', now: 'later' });
  assert.equal(resumed.rounds[2].mainDealer, 1, 'manual override must not persist beyond the next score round');
  const anotherWrong = applyRound(wrong, { type: 'wrong', wrongPlayer: 0 }, { id: 'wrong2', now: 'later' });
  assert.equal(anotherWrong.mainDealer, null);
  assert.deepEqual(undoLastRound(anotherWrong), wrong);
});

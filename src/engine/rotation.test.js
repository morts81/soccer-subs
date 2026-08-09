import { describe, it, expect, beforeEach } from 'vitest';
import * as E from './rotation.js';

const NAMES = [
  'Dottie', 'Val', 'Kora', 'Dylan', 'Pippa', 'Kit',
  'Chanel', 'Harriet', 'Leni', 'Claudia', 'Amelia',
];

const idOf = (s, name) => s.players.find((p) => p.name === name).id;
const nameOf = (s, id) => s.players.find((p) => p.id === id)?.name;
const names = (s, ids) => ids.map((id) => nameOf(s, id));

let game;
beforeEach(() => {
  game = E.createGame(NAMES);
  game.clock.running = true;
});

describe('derived roles (§4.3)', () => {
  it('matches the prototype layout: keeper + 6 field + 4 bench', () => {
    const r = E.roles(game);
    expect(nameOf(game, r.keeperId)).toBe('Dottie');
    expect(names(game, r.field)).toEqual(['Val', 'Kora', 'Dylan', 'Pippa', 'Kit', 'Chanel']);
    expect(names(game, r.bench)).toEqual(['Harriet', 'Leni', 'Claudia', 'Amelia']);
    expect(names(game, r.nextOff)).toEqual(['Val', 'Kora', 'Dylan']);
    expect(names(game, r.nextIn)).toEqual(['Harriet', 'Leni', 'Claudia']);
  });
});

describe('defaultSubsPerRotation', () => {
  it('matches the worked example: 6 + keeper on pitch, 9 on the list, 2 subs', () => {
    const settings = { ...E.DEFAULT_SETTINGS, fieldPlayers: 6, keeperEnabled: true };
    expect(E.defaultSubsPerRotation(9, settings)).toBe(2);
  });

  it('drops the keeper slot when there is no keeper', () => {
    const settings = { ...E.DEFAULT_SETTINGS, fieldPlayers: 6, keeperEnabled: false };
    expect(E.defaultSubsPerRotation(9, settings)).toBe(3);
  });

  it('clamps to 1 when the squad is exactly the starting lineup', () => {
    const settings = { ...E.DEFAULT_SETTINGS, fieldPlayers: 6, keeperEnabled: true };
    expect(E.defaultSubsPerRotation(7, settings)).toBe(1);
  });

  it('clamps to fieldPlayers when the bench outnumbers the field', () => {
    const settings = { ...E.DEFAULT_SETTINGS, fieldPlayers: 4, keeperEnabled: true };
    expect(E.defaultSubsPerRotation(15, settings)).toBe(4);
  });
});

describe('scheduled rotation (§A5)', () => {
  it('produces the worked example from the spec', () => {
    const after = E.applyRotation(game, 300_000);
    const r = E.roles(after);
    expect(nameOf(after, r.keeperId)).toBe('Dottie');
    expect(names(after, r.field)).toEqual(['Pippa', 'Kit', 'Chanel', 'Harriet', 'Leni', 'Claudia']);
    expect(names(after, r.bench)).toEqual(['Amelia', 'Val', 'Kora', 'Dylan']);
  });

  it('is proposed, not auto-applied', () => {
    const proposed = E.proposeRotation(game);
    expect(names(proposed, proposed.pendingRotation.off)).toEqual(['Val', 'Kora', 'Dylan']);
    expect(E.roles(proposed).field[0]).toBe(E.roles(game).field[0]); // nothing moved yet
  });

  it('cancelling postpones rather than skips (D2b)', () => {
    const proposed = E.proposeRotation(game, 300_000);
    const after = E.postponeRotation(proposed);
    expect(after.pendingRotation).toBeNull();
    expect(names(after, E.roles(after).nextOff)).toEqual(['Val', 'Kora', 'Dylan']);
  });

  it('postponing does not reset the countdown — it stays due (D2b)', () => {
    const proposed = E.proposeRotation(game, 300_000);
    const after = E.postponeRotation(proposed);
    expect(after.clock.lastRotationMs).toBe(game.clock.lastRotationMs);
    expect(E.msUntilRotation(after, 300_000)).toBe(0);
    expect(after.clock.postponed).toBe(true);
  });

  it('applying a rotation clears the postponed flag', () => {
    const proposed = E.postponeRotation(E.proposeRotation(game, 300_000));
    const after = E.applyRotation(proposed, 300_000);
    expect(after.clock.postponed).toBe(false);
  });
});

describe('Scenario: Basic early swap', () => {
  it('puts the incoming player last in the field order', () => {
    const after = E.earlySwap(game, idOf(game, 'Pippa'), idOf(game, 'Harriet'), 120_000);
    const r = E.roles(after);
    expect(names(after, r.field).at(-1)).toBe('Harriet');
    expect(r.bench.map((id) => nameOf(after, id))).toContain('Pippa');
  });

  it('does not reset the rotation countdown (D3)', () => {
    const after = E.earlySwap(game, idOf(game, 'Pippa'), idOf(game, 'Harriet'), 120_000);
    expect(after.clock.lastRotationMs).toBe(game.clock.lastRotationMs);
    expect(E.msUntilRotation(after, 120_000)).toBe(180_000);
  });

  it('places the outgoing player on the bench by playing time (§4.2)', () => {
    const s = E.createGame(NAMES);
    s.clock.running = true;
    const set = (n, ms) => (s.players.find((p) => p.name === n).accumulatedMs = ms);
    set('Harriet', 300_000);
    set('Leni', 400_000);
    set('Claudia', 500_000);
    set('Amelia', 600_000);
    set('Pippa', 450_000);

    const after = E.earlySwap(s, idOf(s, 'Pippa'), idOf(s, 'Harriet'), 0);
    // Pippa (7:30) slots between Leni (6:40) and Claudia (8:20).
    expect(names(after, E.roles(after, 0).bench)).toEqual(['Leni', 'Pippa', 'Claudia', 'Amelia']);
  });
});

describe('Scenario: Next-off group backfills (§4.3)', () => {
  it('promotes the next field player and keeps the group size', () => {
    const after = E.earlySwap(game, idOf(game, 'Kora'), idOf(game, 'Harriet'), 60_000);
    const r = E.roles(after);
    expect(r.nextOff).toHaveLength(3);
    expect(names(after, r.nextOff)).toEqual(['Val', 'Dylan', 'Pippa']);
    expect(names(after, r.nextOff)).not.toContain('Kora');
  });
});

describe('Scenario: No immediate bounce-back (§4.2 guard)', () => {
  it('keeps a just-subbed player out of Next in', () => {
    const s = E.createGame(NAMES);
    s.clock.running = true;
    // Pippa has the least time in the squad, so byTime would put her first.
    s.players.forEach((p) => (p.accumulatedMs = 600_000));
    s.players.find((p) => p.name === 'Pippa').accumulatedMs = 0;

    const after = E.earlySwap(s, idOf(s, 'Pippa'), idOf(s, 'Harriet'), 280_000);
    expect(names(after, E.roles(after).nextIn)).not.toContain('Pippa');

    // A rotation 20s later must not bring her back on.
    const rotated = E.applyRotation(after, 300_000);
    expect(names(rotated, E.roles(rotated).onFieldIds)).not.toContain('Pippa');
  });

  it('allows her back once the rest window has passed', () => {
    const s = E.createGame(NAMES);
    s.clock.running = true;
    s.players.forEach((p) => (p.accumulatedMs = 600_000));
    s.players.find((p) => p.name === 'Pippa').accumulatedMs = 0;

    const after = E.earlySwap(s, idOf(s, 'Pippa'), idOf(s, 'Harriet'), 0);
    const pippa = idOf(after, 'Pippa');
    expect(E.benchEligible(after, pippa, 60_000)).toBe(false);
    expect(E.benchEligible(after, pippa, 120_000)).toBe(true);
    // Least time in the squad, so once rested she is first back on.
    expect(names(after, E.roles(after, 120_000).nextIn)[0]).toBe('Pippa');
  });
});

describe('Scenario: red and absorb windows (§4.4)', () => {
  it('detects the final 10 seconds', () => {
    expect(E.inRedWindow(game, 292_000)).toBe(true);
    expect(E.inRedWindow(game, 280_000)).toBe(false);
  });
  it('detects the absorb window', () => {
    expect(E.inAbsorbWindow(game, 250_000)).toBe(true);
    expect(E.inAbsorbWindow(game, 200_000)).toBe(false);
  });
});

describe('Scenario: Keeper off early (§5.1)', () => {
  it('bench player straight into goal keeps the field count', () => {
    const before = E.roles(game).field.length;
    const after = E.earlySwap(game, idOf(game, 'Dottie'), idOf(game, 'Harriet'), 60_000);
    const r = E.roles(after);
    expect(nameOf(after, r.keeperId)).toBe('Harriet');
    expect(r.field).toHaveLength(before);
    expect(names(after, r.bench)).toContain('Dottie');
  });

  it('field player takes the gloves and a bench player fills the slot', () => {
    const after = E.keeperHandover(
      game,
      idOf(game, 'Dottie'),
      idOf(game, 'Chanel'),
      idOf(game, 'Harriet'),
      60_000
    );
    const r = E.roles(after);
    expect(nameOf(after, r.keeperId)).toBe('Chanel');
    expect(names(after, r.field)).toContain('Harriet');
    expect(names(after, r.field)).not.toContain('Chanel');
    expect(names(after, r.bench)).toContain('Dottie');
    expect(r.field).toHaveLength(6);
  });

  it('swapping keeper with a field player moves nobody else', () => {
    const after = E.swapKeeperWithField(game, idOf(game, 'Chanel'), 60_000);
    const r = E.roles(after);
    expect(nameOf(after, r.keeperId)).toBe('Chanel');
    expect(names(after, r.field)).toContain('Dottie');
    expect(names(after, r.bench)).toEqual(['Harriet', 'Leni', 'Claudia', 'Amelia']);
  });

  // The long-press sheet offers "Bring on in goal" for bench players, which
  // routes to the same call. A bench player has no field slot to trade.
  it('putting a bench player in goal does not list them twice', () => {
    const after = E.swapKeeperWithField(game, idOf(game, 'Leni'), 60_000);
    expect(new Set(after.order).size).toBe(after.order.length);
    expect(after.order).toHaveLength(after.players.length);
  });

  it('putting a bench player in goal benches the old keeper by playing time', () => {
    const after = E.swapKeeperWithField(game, idOf(game, 'Leni'), 60_000);
    const r = E.roles(after);
    expect(nameOf(after, r.keeperId)).toBe('Leni');
    expect(names(after, r.field)).toEqual(['Val', 'Kora', 'Dylan', 'Pippa', 'Kit', 'Chanel']);
    // Dottie kept for the full minute, so she sits behind the three who didn't.
    expect(names(after, r.bench)).toEqual(['Harriet', 'Claudia', 'Amelia', 'Dottie']);
  });
});

describe('Scenario: Empty bench (§5.2)', () => {
  it('reduces the effective field count rather than fielding phantoms', () => {
    const small = E.createGame(NAMES.slice(0, 5)); // keeper + 4
    expect(E.effectiveFieldCount(small)).toBe(4);
    expect(E.roles(small).bench).toHaveLength(0);
    expect(E.roles(small).nextIn).toHaveLength(0);
  });
});

describe('Scenario: Injured player (§5.3)', () => {
  it('removes them from rotation and stops their clock', () => {
    let s = E.applyRotation(game, 300_000); // Leni is now on the field
    s = E.markUnavailable(s, idOf(s, 'Leni'), 'injured', 400_000, idOf(s, 'Amelia'));
    const r = E.roles(s);
    expect(names(s, r.onFieldIds)).not.toContain('Leni');
    expect(names(s, r.bench)).not.toContain('Leni');
    expect(E.roleOf(s, idOf(s, 'Leni'))).toBe('unavailable');
    expect(names(s, r.onFieldIds)).toContain('Amelia');

    const played = E.playedMs(s, idOf(s, 'Leni'), 500_000);
    expect(played).toBe(E.playedMs(s, idOf(s, 'Leni'), 900_000)); // frozen
  });

  it('returns them to the bench, never straight to the field', () => {
    let s = E.markUnavailable(game, idOf(game, 'Val'), 'injured', 60_000, idOf(game, 'Harriet'));
    s = E.returnToRotation(s, idOf(s, 'Val'), 200_000);
    expect(names(s, E.roles(s).onFieldIds)).not.toContain('Val');
    expect(names(s, E.roles(s).bench)).toContain('Val');
  });
});

describe('Scenario: mid-game arrival (§5.4)', () => {
  it('credited as average does not pin to the front of the bench', () => {
    let s = E.createGame(NAMES);
    s.clock.running = true;
    s.players.forEach((p) => (p.accumulatedMs = 600_000));

    const fresh = E.addPlayerMidGame(s, 'Late', 'zero', 600_000);
    expect(names(fresh, E.roles(fresh).nextIn)[0]).toBe('Late');

    const credited = E.addPlayerMidGame(s, 'Late', 'average', 600_000);
    expect(names(credited, E.roles(credited).nextIn)[0]).not.toBe('Late');
  });
});

describe('Scenario: Undo (§5.6)', () => {
  it('restores the state before the second of three swaps', () => {
    const a = E.earlySwap(game, idOf(game, 'Pippa'), idOf(game, 'Harriet'), 60_000);
    const afterFirst = names(a, a.order);
    const b = E.earlySwap(a, idOf(a, 'Kit'), idOf(a, 'Leni'), 120_000);
    const c = E.earlySwap(b, idOf(b, 'Val'), idOf(b, 'Claudia'), 180_000);
    const undone = E.undo(E.undo(c));
    expect(names(undone, undone.order)).toEqual(afterFirst);
  });

  it('restores playing time, not just order', () => {
    const a = E.earlySwap(game, idOf(game, 'Pippa'), idOf(game, 'Harriet'), 60_000);
    const before = E.playedMs(a, idOf(a, 'Harriet'), 60_000);
    const b = E.earlySwap(a, idOf(a, 'Kit'), idOf(a, 'Leni'), 120_000);
    const undone = E.undo(b);
    expect(E.playedMs(undone, idOf(undone, 'Harriet'), 60_000)).toBe(before);
  });

  it('does not rewind the displayed game clock', () => {
    const a = E.earlySwap(game, idOf(game, 'Pippa'), idOf(game, 'Harriet'), 60_000);
    // Real time has moved on well past the swap by the time it's undone.
    const undone = E.undo(a, 600_000);
    expect(undone.clock.periodElapsedMs).toBe(600_000);
  });

  it('still restores lastRotationMs, which governs scheduling rather than wall time', () => {
    const rotated = E.applyRotation(game, 300_000);
    const undone = E.undo(rotated, 900_000);
    expect(undone.clock.lastRotationMs).toBe(0);
  });
});

describe('time accounting (§4.5)', () => {
  it('accrues only to players on the field', () => {
    const s = E.syncStints(game, 0);
    expect(E.playedMs(s, idOf(s, 'Val'), 120_000)).toBe(120_000);
    expect(E.playedMs(s, idOf(s, 'Harriet'), 120_000)).toBe(0);
  });

  it('keeps accruing to on-field players while a rotation sits pending (§5.10)', () => {
    const s = E.proposeRotation(E.syncStints(game, 0));
    expect(E.playedMs(s, idOf(s, 'Val'), 320_000)).toBe(320_000);
  });

  it('survives a period change', () => {
    let s = E.syncStints(game, 0);
    s = E.endPeriod(s, 1_200_000);
    const banked = E.playedMs(s, idOf(s, 'Val'), 0);
    expect(banked).toBe(1_200_000);

    s = E.startNextPeriod(s);
    s.clock.running = true;
    s = E.syncStints(s, 0);

    // Only four players sat out the first half but six start the second, so
    // two of the first-half XI stay on. Chanel is last in the queue and drops
    // to the bench: her banked time carries over intact but stops growing.
    expect(E.playedMs(s, idOf(s, 'Chanel'), 60_000)).toBe(banked);
    // Harriet sat out the first half, so she starts the second and accrues.
    expect(E.playedMs(s, idOf(s, 'Harriet'), 60_000)).toBe(60_000);
  });

  it('banks an unstopped stint when the period rolls over', () => {
    let s = E.syncStints(game, 0);
    // No endPeriod call — the coach just taps straight into the second half.
    s = E.startNextPeriod(s, 1_200_000);
    expect(E.playedMs(s, idOf(s, 'Val'), 0)).toBe(1_200_000);
  });
});

describe('rebalance (§4.6)', () => {
  it('sorts bench ascending and field descending by time played', () => {
    const s = E.createGame(NAMES);
    s.clock.running = true;
    s.players.forEach((p, i) => (p.accumulatedMs = i * 60_000));
    const after = E.rebalance(s, 0);
    const r = E.roles(after);
    const fieldTimes = r.field.map((id) => E.playedMs(after, id, 0));
    const benchTimes = r.bench.map((id) => E.playedMs(after, id, 0));
    expect([...fieldTimes].sort((a, b) => b - a)).toEqual(fieldTimes);
    expect([...benchTimes].sort((a, b) => a - b)).toEqual(benchTimes);
  });
});

describe('fairness over a full game', () => {
  // A positional queue equalises only at whole cycle boundaries. With 10
  // outfield players rotating 3 at a time the cycle is 10 rotations, so a
  // 40-minute game at 5-minute rotations stops two rotations short.
  it('is perfectly even after a whole cycle', () => {
    let s = E.syncStints(game, 0);
    for (let i = 1; i <= 10; i++) s = E.syncStints(E.applyRotation(s, i * 300_000), i * 300_000);
    const outfield = s.order.slice(1).map((id) => E.playedMs(s, id, 3_000_000));
    expect(Math.max(...outfield) - Math.min(...outfield)).toBe(0);
  });

  it('leaves a documented spread when the game stops mid-cycle', () => {
    let s = E.syncStints(game, 0);
    for (let i = 1; i <= 8; i++) s = E.syncStints(E.applyRotation(s, i * 300_000), i * 300_000);
    const outfield = s.order.slice(1).map((id) => E.playedMs(s, id, 2_400_000));
    expect(Math.max(...outfield) - Math.min(...outfield)).toBe(600_000);
  });

  it('balanced mode roughly halves the mid-cycle spread', () => {
    let s = E.createGame(NAMES, { fairnessMode: 'balanced' });
    s.clock.running = true;
    s = E.syncStints(s, 0);
    for (let i = 1; i <= 8; i++) {
      s = E.syncStints(E.prepareRotation(s, i * 300_000), i * 300_000);
      s = E.syncStints(E.applyRotation(s, i * 300_000), i * 300_000);
    }
    const outfield = s.order.slice(1).map((id) => E.playedMs(s, id, 2_400_000));
    expect(Math.max(...outfield) - Math.min(...outfield)).toBeLessThanOrEqual(300_000);
  });

  it('confines the cost of an early swap to the two players involved', () => {
    let s = E.syncStints(game, 0);
    for (let i = 1; i <= 10; i++) {
      const t = i * 300_000;
      if (i === 2) {
        const r = E.roles(s, t - 100_000);
        s = E.syncStints(E.earlySwap(s, r.field[2], r.bench[0], t - 100_000), t - 100_000);
      }
      s = E.syncStints(E.applyRotation(s, t), t);
    }
    const outfield = s.order.slice(1).map((id) => E.playedMs(s, id, 3_000_000));
    const mean = outfield.reduce((a, b) => a + b, 0) / outfield.length;
    const onTarget = outfield.filter((ms) => Math.abs(ms - mean) < 60_000);
    // Everyone except the two players in the swap lands on the mean.
    expect(onTarget.length).toBeGreaterThanOrEqual(outfield.length - 3);
    expect(Math.max(...outfield.map((ms) => Math.abs(ms - mean)))).toBeLessThanOrEqual(330_000);
  });
});

describe('fairness advice', () => {
  it('flags a game that stops mid-cycle and suggests an interval that does not', () => {
    const a = E.fairnessAdvice(game);
    expect(a.cycle).toBe(10);
    expect(a.rotationsInGame).toBe(8);
    expect(a.evenlyDivides).toBe(false);
    expect(a.suggestedRotationSeconds).toBe(240);
    expect(a.everyPlayerMinutes).toBe(24);
  });

  it('is content when the interval already divides evenly', () => {
    const s = E.createGame(NAMES, { rotationSeconds: 240 });
    expect(E.fairnessAdvice(s).evenlyDivides).toBe(true);
  });
});

describe('end of period', () => {
  // 40 minutes over 2 periods = a 20-minute half.
  it('stops proposing rotations once the period is over', () => {
    expect(E.rotationDue(game, 1_500_000)).toBe(false);
    expect(E.periodOver(game, 1_500_000)).toBe(true);
  });

  it('stops proposing inside the last three minutes, before the whistle', () => {
    // 18:00 played, 2:00 left, and a rotation is otherwise due.
    const s = { ...game, clock: { ...game.clock, lastRotationMs: 780_000 } };
    expect(E.msUntilRotation(s, 1_080_000)).toBe(0);
    expect(E.rotationsDone(s, 1_080_000)).toBe(true);
    expect(E.rotationDue(s, 1_080_000)).toBe(false);
  });

  it('still rotates with more than the remainder left', () => {
    const s = { ...game, clock: { ...game.clock, lastRotationMs: 600_000 } };
    expect(E.rotationsDone(s, 900_000)).toBe(false);
    expect(E.rotationDue(s, 900_000)).toBe(true);
  });

  it('the remainder guard can be switched off', () => {
    const s = E.createGame(NAMES, { minRotationRemainderSeconds: 0 });
    s.clock.lastRotationMs = 780_000;
    expect(E.rotationsDone(s, 1_080_000)).toBe(false);
    expect(E.rotationDue(s, 1_080_000)).toBe(true);
  });

  it('knows the difference between a period ending and the game ending', () => {
    expect(E.isFinalPeriod(game)).toBe(false);
    expect(E.gameOver(game, 1_500_000)).toBe(false);
    const second = E.startNextPeriod(game);
    expect(E.isFinalPeriod(second)).toBe(true);
    expect(E.gameOver(second, 1_500_000)).toBe(true);
  });
});

describe('second half re-seeding', () => {
  it('starts the least-played players', () => {
    let s = E.syncStints(game, 0);
    s = E.endPeriod(s, 1_200_000); // keeper + 6 played, 4 sat
    const second = E.startNextPeriod(s);
    const r = E.roles(second);
    // The four who sat out are all on, and the four most-played are benched.
    expect(names(second, r.field)).toEqual(
      expect.arrayContaining(['Harriet', 'Leni', 'Claudia', 'Amelia'])
    );
    expect(r.bench).toHaveLength(4);
    const benchTime = r.bench.map((id) => E.playedMs(second, id, 0));
    const fieldTime = r.field.map((id) => E.playedMs(second, id, 0));
    expect(Math.min(...benchTime)).toBeGreaterThanOrEqual(Math.max(...fieldTime));
  });

  it('leaves the keeper in goal — that is a coaching call, not a fairness one', () => {
    let s = E.syncStints(game, 0);
    s = E.endPeriod(s, 1_200_000);
    expect(nameOf(E.startNextPeriod(s), E.roles(E.startNextPeriod(s)).keeperId)).toBe('Dottie');
  });

  it('can be switched off, leaving the queue exactly as the half ended', () => {
    let s = E.createGame(NAMES, { balanceAtPeriodStart: false });
    s.clock.running = true;
    s = E.endPeriod(E.syncStints(s, 0), 1_200_000);
    const before = names(s, s.order);
    expect(names(E.startNextPeriod(s), E.startNextPeriod(s).order)).toEqual(before);
  });
});

describe('holding a player on (§5.11)', () => {
  it('skips them in the next-off group without moving them down the queue', () => {
    const val = idOf(game, 'Val');
    const held = E.toggleHeldOn(game, val);
    const r = E.roles(held);
    expect(names(held, r.nextOff)).toEqual(['Kora', 'Dylan', 'Pippa']);
    expect(names(held, r.field)[0]).toBe('Val'); // still first in the queue
  });

  it('keeps both sides of the swap the same size', () => {
    let s = E.toggleHeldOn(game, idOf(game, 'Val'));
    s = E.toggleHeldOn(s, idOf(s, 'Kora'));
    s = E.toggleHeldOn(s, idOf(s, 'Dylan'));
    s = E.toggleHeldOn(s, idOf(s, 'Pippa'));
    const r = E.roles(s);
    // Only Kit and Chanel are free to come off, so only two can come on.
    expect(names(s, r.nextOff)).toEqual(['Kit', 'Chanel']);
    expect(r.nextIn).toHaveLength(2);
  });

  it('a held player survives a scheduled rotation', () => {
    const s = E.applyRotation(E.toggleHeldOn(game, idOf(game, 'Val')), 300_000);
    expect(names(s, E.roles(s).onFieldIds)).toContain('Val');
  });

  it('releases the hold if they leave the field anyway', () => {
    let s = E.toggleHeldOn(game, idOf(game, 'Val'));
    s = E.earlySwap(s, idOf(s, 'Val'), idOf(s, 'Harriet'), 60_000);
    expect(E.getPlayer(s, idOf(s, 'Val')).heldOn).toBe(false);
  });

  it('is cleared by the half-time break', () => {
    const s = E.startNextPeriod(E.toggleHeldOn(game, idOf(game, 'Val')));
    expect(s.players.every((p) => !p.heldOn)).toBe(true);
  });

  it('toggles back off', () => {
    const val = idOf(game, 'Val');
    const released = E.toggleHeldOn(E.toggleHeldOn(game, val), val);
    expect(E.getPlayer(released, val).heldOn).toBe(false);
    expect(names(released, E.roles(released).nextOff)).toEqual(['Val', 'Kora', 'Dylan']);
  });
});

describe('leastTimeId', () => {
  it('picks the single most-underplayed candidate', () => {
    const bench = E.roles(game).bench;
    bench.forEach((id, i) => {
      game.players.find((p) => p.id === id).accumulatedMs = i * 60_000;
    });
    expect(E.leastTimeId(game, bench, 0)).toBe(bench[0]);
  });

  it('returns null when the lowest time is tied — e.g. kickoff, everyone at 0:00', () => {
    const bench = E.roles(game).bench;
    expect(E.leastTimeId(game, bench, 0)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(E.leastTimeId(game, [], 0)).toBeNull();
  });
});

describe('goal scoring', () => {
  it('records an attributed goal and increments the score', () => {
    const scorer = idOf(game, 'Kit');
    const after = E.addGoal(game, scorer, 0);
    expect(after.score[0]).toBe(1);
    expect(after.scorers).toEqual([{ id: scorer, name: 'Kit', atMs: 0 }]);
  });

  it('records an unattributed goal when no scorer is chosen', () => {
    const after = E.addGoal(game, null, 0);
    expect(after.score[0]).toBe(1);
    expect(after.scorers).toEqual([{ id: null, name: null, atMs: 0 }]);
  });

  it('removing the last goal drops the score and the matching scorer entry', () => {
    const withGoal = E.addGoal(game, idOf(game, 'Kit'), 0);
    const reverted = E.removeLastGoal(withGoal);
    expect(reverted.score[0]).toBe(0);
    expect(reverted.scorers).toEqual([]);
  });

  it('does not go below zero goals', () => {
    const reverted = E.removeLastGoal(game);
    expect(reverted.score[0]).toBe(0);
  });
});

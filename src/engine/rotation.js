// Rotation engine.
//
// Everything here is a pure function of state. No timers, no DOM, no storage.
// The UI owns the wall clock; this module only ever receives elapsed
// milliseconds. That separation is what makes it testable and what stops a
// backgrounded tab from corrupting playing time.
//
// Every mutation rebuilds `order` from role arrays rather than splicing into
// it. Splicing by a derived index is how you get off-by-one bugs that only
// show up once someone is injured and the field count shifts underneath you.
//
// Spec references (§) point at early-swap-spec.md.

export const DEFAULT_SETTINGS = {
  fieldPlayers: 6,
  keeperEnabled: true,
  subsPerRotation: 3,
  subsPerRotationAuto: true, // recompute subsPerRotation from squad size until overridden
  rotationSeconds: 300,
  totalGameMinutes: 40,
  periods: 2,
  minBenchRestSeconds: 90, // §4.2 guard
  absorbWindowSeconds: 60, // §4.4
  minRotationRemainderSeconds: 180, // don't sub someone on for a token stint
  earlyOffPlacement: 'byTime', // 'byTime' | 'backOfBench' | 'frontOfBench'
  keeperTimeCounts: true,
  pauseGameClockOnDialog: false,
  confirmPauseClock: true,
  balanceAtPeriodStart: true,
  fairnessMode: 'queue', // 'queue' | 'balanced' (§4.6)
};

let idSeq = 0;
export const newId = () => `p${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function createPlayer(name) {
  return {
    id: newId(),
    name: String(name).trim(),
    accumulatedMs: 0,
    stintStartMs: null,
    lastOffMs: null,
    unavailable: null,
    heldOn: false, // kept on the field until the coach releases them (§5.11)
  };
}

export function createGame(names = [], settings = {}) {
  const players = names.map(createPlayer);
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    players,
    order: players.map((p) => p.id),
    clock: { period: 1, running: false, periodElapsedMs: 0, lastRotationMs: 0, postponed: false },
    score: [0, 0],
    scorers: [],
    pendingRotation: null, // §A6b — proposed, never auto-applied
    events: [],
    undoStack: [],
  };
}

/**
 * The bench size a fresh squad implies: everyone not on the field or in
 * goal. That's the natural number of subs to rotate at once — swapping fewer
 * leaves players sitting out who didn't need to, swapping more is capped by
 * `benchEligible` anyway. Clamped to at least 1 (there's always someone to
 * bring on) and at most fieldPlayers (the slider's own ceiling).
 */
export function defaultSubsPerRotation(playerCount, settings) {
  const keeperSlots = settings.keeperEnabled ? 1 : 0;
  const bench = playerCount - keeperSlots - settings.fieldPlayers;
  return Math.min(Math.max(1, bench), Math.max(1, settings.fieldPlayers));
}

export const getPlayer = (state, id) => state.players.find((p) => p.id === id);
const clone = (state) => structuredClone(state);
const now_ = (state, nowMs) => (nowMs === undefined ? state.clock.periodElapsedMs : nowMs);

// ---------------------------------------------------------------------------
// Time accounting (§4.5)
// ---------------------------------------------------------------------------

export function playedMs(state, id, nowMs) {
  const p = getPlayer(state, id);
  if (!p) return 0;
  const t = now_(state, nowMs);
  const live = p.stintStartMs === null ? 0 : Math.max(0, t - p.stintStartMs);
  return p.accumulatedMs + live;
}

export function stintMs(state, id, nowMs) {
  const p = getPlayer(state, id);
  if (!p || p.stintStartMs === null) return 0;
  return Math.max(0, now_(state, nowMs) - p.stintStartMs);
}

export function meanPlayedMs(state, nowMs) {
  const ids = state.order.filter((id) => !getPlayer(state, id)?.unavailable);
  if (!ids.length) return 0;
  return ids.reduce((s, id) => s + playedMs(state, id, nowMs), 0) / ids.length;
}

// ---------------------------------------------------------------------------
// Derived roles (§4.3). Never stored. Always recomputed.
// ---------------------------------------------------------------------------

export function effectiveFieldCount(state) {
  const available = state.order.filter((id) => !getPlayer(state, id)?.unavailable).length;
  const keeperSlots = state.settings.keeperEnabled ? 1 : 0;
  // Can't field more players than we have (§5.2).
  return Math.max(0, Math.min(state.settings.fieldPlayers, available - keeperSlots));
}

/**
 * §4.2 guard, applied at rotation time rather than at insertion time.
 *
 * A player who comes off early always has zero rest at the moment they hit the
 * bench, so testing eligibility when placing them would push every early-off
 * player to the back of the queue regardless of playing time — which is the
 * exact unfairness the byTime rule exists to prevent. The real question is only
 * ever "can this player come back on *now*", so that is where the guard lives.
 */
export function benchEligible(state, id, nowMs) {
  const min = state.settings.minBenchRestSeconds * 1000;
  if (!min) return true;
  const p = getPlayer(state, id);
  if (!p || p.lastOffMs === null) return true;
  return now_(state, nowMs) - p.lastOffMs >= min;
}

export function roles(state, nowMs) {
  const { settings } = state;
  const active = state.order.filter((id) => !getPlayer(state, id)?.unavailable);
  const keeperSlots = settings.keeperEnabled ? 1 : 0;
  const fieldCount = effectiveFieldCount(state);

  const keeperId = keeperSlots ? active[0] ?? null : null;
  const field = active.slice(keeperSlots, keeperSlots + fieldCount);
  const bench = active.slice(keeperSlots + fieldCount);

  // A held player is skipped by the rotation but keeps their place in `order`.
  // The coach asked for them to stay on, not to move down the queue — so the
  // moment the hold is released they're back where they would have been.
  const rotatable = field.filter((id) => !getPlayer(state, id)?.heldOn);

  // Rested players first, bench order otherwise preserved. If too few are
  // eligible we still fill the slots — short-handed is worse than under-rested.
  const rested = bench.filter((id) => benchEligible(state, id, nowMs));
  const notRested = bench.filter((id) => !benchEligible(state, id, nowMs));

  // Both sides of the swap must be the same size or the field count drifts:
  // hold two players on out of a group of three and only one leaves, so only
  // one can come on.
  const swapCount = Math.min(settings.subsPerRotation, rotatable.length, bench.length);

  // Selection stays positional rather than re-sorting by playing time here.
  // Both queues are already kept in time order by `placeOnField`/`placeOnBench`
  // at the point players move, so on any state this build produces the two are
  // the same answer — and re-sorting on every read costs the circular queue its
  // even-at-the-cycle-boundary guarantee for no gain (§D1).
  return {
    keeperId,
    field,
    bench,
    nextOff: rotatable.slice(0, swapCount),
    nextIn: [...rested, ...notRested].slice(0, swapCount),
    onFieldIds: keeperId ? [keeperId, ...field] : [...field],
  };
}

export function roleOf(state, id, nowMs) {
  if (getPlayer(state, id)?.unavailable) return 'unavailable';
  const r = roles(state, nowMs);
  if (id === r.keeperId) return 'keeper';
  if (r.nextOff.includes(id)) return 'nextOff';
  if (r.field.includes(id)) return 'field';
  if (r.nextIn.includes(id)) return 'nextIn';
  return 'bench';
}

// ---------------------------------------------------------------------------
// Order rebuilding
// ---------------------------------------------------------------------------

function rebuild(state, { keeperId, field, bench }) {
  const placed = new Set([keeperId, ...field, ...bench].filter(Boolean));
  const rest = state.order.filter((id) => !placed.has(id)); // unavailable, parked
  state.order = [...(keeperId ? [keeperId] : []), ...field, ...bench, ...rest];
}

/**
 * §4.2 — where an early-off player rejoins the bench. Ranked by playing time
 * ascending, so a player who has had little time returns near the front and
 * the queue self-corrects over the next couple of rotations.
 */
export function benchInsertIndex(state, bench, ms, nowMs) {
  return bench.filter((id) => playedMs(state, id, nowMs) <= ms).length;
}

function placeOnBench(state, bench, id, nowMs) {
  const mode = state.settings.earlyOffPlacement;
  const out = [...bench];
  if (mode === 'frontOfBench') out.unshift(id);
  else if (mode === 'backOfBench') out.push(id);
  else out.splice(benchInsertIndex(state, bench, playedMs(state, id, nowMs), nowMs), 0, id);
  return out;
}

/**
 * §4.1, completed: where a player coming on *early* lands in the field order,
 * ranked by playing time descending. The mirror of §4.2 on the other side of
 * the swap, and used only for early swaps — a scheduled rotation appends,
 * which is what keeps the circular queue exactly even at a cycle boundary.
 *
 * §4.1 says "back of the field order" so an incoming player gets a full stint
 * and never comes straight back off. That still holds: a player arriving with
 * the least time sorts to the back, and ties sort to the back too, so the
 * ordinary case is unchanged. But it was written assuming the incoming player
 * is the one who has waited longest, which is true of a rotation and not of a
 * coach's early swap. Swap on someone who has *already* played a lot and an
 * unconditional back-of-queue parks the most-played player where the rotation
 * can never reach them, leaving the next-off group to fill with whoever has
 * played least — the exact inversion of the job this app exists to do.
 */
export function fieldInsertIndex(state, field, ms, nowMs) {
  return field.filter((id) => playedMs(state, id, nowMs) >= ms).length;
}

function placeOnField(state, field, id, nowMs) {
  const out = [...field];
  out.splice(fieldInsertIndex(state, field, playedMs(state, id, nowMs), nowMs), 0, id);
  return out;
}

// ---------------------------------------------------------------------------
// Stint clocks
// ---------------------------------------------------------------------------

function stopStint(state, id, nowMs) {
  const p = getPlayer(state, id);
  if (!p) return;
  if (p.stintStartMs !== null) {
    p.accumulatedMs += Math.max(0, nowMs - p.stintStartMs);
    p.stintStartMs = null;
  }
  p.lastOffMs = nowMs;
}

/** Reconcile every stint clock against who is actually on the field. */
export function syncStints(state, nowMs) {
  const r = roles(state, nowMs);
  const on = new Set(r.onFieldIds);
  for (const p of state.players) {
    // A hold only means anything for someone actually on the field. Clearing it
    // here rather than in each mutation means no path can leave a benched
    // player silently held, ready to surprise the coach when they next come on.
    if (p.heldOn && !on.has(p.id)) p.heldOn = false;

    const counts = state.settings.keeperTimeCounts || p.id !== r.keeperId;
    const shouldRun = on.has(p.id) && !p.unavailable && state.clock.running && counts;
    if (shouldRun && p.stintStartMs === null) p.stintStartMs = nowMs;
    else if (!shouldRun && p.stintStartMs !== null) {
      p.accumulatedMs += Math.max(0, nowMs - p.stintStartMs);
      p.stintStartMs = null;
      if (!on.has(p.id)) p.lastOffMs = nowMs;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Events and undo
// ---------------------------------------------------------------------------

function logEvent(state, event) {
  state.events = [
    ...state.events,
    {
      id: newId(),
      atMs: state.clock.periodElapsedMs,
      period: state.clock.period,
      wallClock: Date.now(),
      off: [],
      on: [],
      ...event,
    },
  ];
}

function pushUndo(state) {
  state.undoStack = [
    ...state.undoStack.slice(-9),
    {
      order: [...state.order],
      players: state.players.map((p) => ({ ...p })),
      clock: { ...state.clock },
    },
  ];
}

/**
 * §5.6 — restore a full snapshot rather than inverting an operation.
 *
 * The roster and playing time roll back to the snapshot; the wall clock does
 * not. Real time has kept passing since that snapshot was taken, and
 * rewinding `periodElapsedMs` to a stale value made the displayed game clock
 * visibly jump backwards on every undo — confusing, and not what "undo the
 * last swap" means. `period` and `lastRotationMs` still come from the
 * snapshot: they govern rotation scheduling, not wall time, so reversing a
 * rotation or a period change needs them restored.
 */
export function undo(state, nowMs) {
  if (!state.undoStack.length) return state;
  const next = clone(state);
  const snap = next.undoStack.pop();
  next.order = snap.order;
  next.players = next.players.map((p) => snap.players.find((s) => s.id === p.id) ?? p);
  next.clock = {
    ...snap.clock,
    running: state.clock.running,
    periodElapsedMs: nowMs ?? state.clock.periodElapsedMs,
  };
  next.pendingRotation = null;
  logEvent(next, { type: 'UNDO' });
  return next;
}

export const canUndo = (state) => state.undoStack.length > 0;

// ---------------------------------------------------------------------------
// Rotation (§A5) — proposed, then applied
// ---------------------------------------------------------------------------

export function proposeRotation(state, nowMs) {
  const next = clone(state);
  const r = roles(next, nowMs);
  if (!r.nextOff.length || !r.nextIn.length) return next;
  next.pendingRotation = { off: r.nextOff, on: r.nextIn, proposedAtMs: now_(next, nowMs) };
  return next;
}

export function applyRotation(state, nowMs) {
  const next = clone(state);
  const t = now_(next, nowMs);
  const r = roles(next, t);
  const { off, on } = next.pendingRotation ?? { off: r.nextOff, on: r.nextIn };
  if (!off.length || !on.length) {
    next.pendingRotation = null;
    return next;
  }

  pushUndo(next);
  off.forEach((id) => stopStint(next, id, t));

  // Outgoing players rejoin the bench by playing time, exactly as they do on
  // an early swap. With an undisturbed queue everyone's time is equal and ties
  // resolve to the back, so this is identical to a plain circular queue. Once
  // an early swap has perturbed the order it quietly pulls it back into line
  // instead of preserving the imbalance for the rest of the game.
  let bench = r.bench.filter((id) => !on.includes(id));
  for (const id of off) bench = placeOnBench(next, bench, id, t);

  // Incoming players append to the back of the field, unconditionally. This is
  // the circular queue doing its job: `on` comes off the front of a bench kept
  // in ascending time order, so they are already the least played, and a plain
  // append is what makes the queue come out exactly even at each cycle
  // boundary. Sorting here instead — even "correctly", by time — trades that
  // guarantee for a slightly better mid-cycle spread, and a full cycle is the
  // target the settings advice steers the coach onto.
  rebuild(next, {
    keeperId: r.keeperId,
    field: [...r.field.filter((id) => !off.includes(id)), ...on],
    bench,
  });

  next.clock.lastRotationMs = t;
  next.clock.postponed = false;
  next.pendingRotation = null;
  logEvent(next, { type: 'ROTATION', off, on });
  return syncStints(next, t);
}

/**
 * Cancelling postpones rather than skips (§5.9, D2b): the countdown keeps
 * running instead of jumping back to a full fresh interval, so postponing
 * doesn't cost a kid extra minutes on the pitch. `postponed` just stops the
 * dialog re-proposing itself on every tick — the sub stays due (the button
 * stays red) until the coach taps it again themselves.
 */
export function postponeRotation(state) {
  const next = clone(state);
  next.pendingRotation = null;
  next.clock.postponed = true;
  logEvent(next, { type: 'ROTATION_POSTPONED' });
  return next;
}

/** Close the dialog without deciding — it stays pending and the button stays red. */
export function dismissRotation(state) {
  const next = clone(state);
  next.pendingRotation = null;
  return next;
}

// ---------------------------------------------------------------------------
// Early swap (§7) — the feature
// ---------------------------------------------------------------------------

export function earlySwap(state, offId, onId, nowMs) {
  const next = clone(state);
  const t = now_(next, nowMs);
  const r = roles(next, t);

  const incoming = getPlayer(next, onId);
  if (!incoming || incoming.unavailable || offId === onId) return next;

  pushUndo(next);
  stopStint(next, offId, t);

  if (offId === r.keeperId) {
    // §5.1 — a bench player takes the gloves directly. The field is untouched.
    rebuild(next, {
      keeperId: onId,
      field: r.field,
      bench: placeOnBench(next, r.bench.filter((id) => id !== onId), offId, t),
    });
    logEvent(next, { type: 'KEEPER_CHANGE', off: [offId], on: [onId] });
    return syncStints(next, t);
  }

  rebuild(next, {
    keeperId: r.keeperId,
    // §4.1 — incoming slots into the field order by playing time, which puts
    // the usual least-played arrival at the back for a full stint.
    field: placeOnField(next, r.field.filter((id) => id !== offId), onId, t),
    // §4.2 — outgoing inserts into the bench by playing time.
    bench: placeOnBench(next, r.bench.filter((id) => id !== onId), offId, t),
  });

  logEvent(next, { type: 'EARLY_SWAP', off: [offId], on: [onId] });
  return syncStints(next, t);
}

/**
 * §5.1 — keeper comes off, a field player takes the gloves, and a bench player
 * fills the vacated field slot. Three players move.
 */
export function keeperHandover(state, keeperId, newKeeperId, replacementId, nowMs) {
  const next = clone(state);
  const t = now_(next, nowMs);
  const r = roles(next, t);

  pushUndo(next);
  stopStint(next, keeperId, t);

  const field = r.field.filter((id) => id !== newKeeperId);
  if (replacementId) field.push(replacementId);
  const bench = placeOnBench(
    next,
    r.bench.filter((id) => id !== replacementId),
    keeperId,
    t
  );

  rebuild(next, { keeperId: newKeeperId, field, bench });
  logEvent(next, {
    type: 'KEEPER_CHANGE',
    off: [keeperId],
    on: [newKeeperId, replacementId].filter(Boolean),
  });
  return syncStints(next, t);
}

/** Field player takes the gloves; the keeper goes out to the field. No bench. */
export function swapKeeperWithField(state, fieldId, nowMs) {
  const next = clone(state);
  const t = now_(next, nowMs);
  const r = roles(next, t);
  if (!r.keeperId) return next;

  // The long-press sheet offers "Bring on in goal" for bench players too, and a
  // bench player has no field slot to trade. Running the straight swap below
  // would list them twice — in goal and still on the bench — and strand the
  // outgoing keeper at the very back of the queue. That move is an early swap
  // with the keeper coming off, which already places them by playing time.
  if (!r.field.includes(fieldId)) return earlySwap(state, r.keeperId, fieldId, t);

  pushUndo(next);
  rebuild(next, {
    keeperId: fieldId,
    field: r.field.map((id) => (id === fieldId ? r.keeperId : id)),
    bench: r.bench,
  });
  logEvent(next, { type: 'KEEPER_CHANGE', off: [r.keeperId], on: [fieldId] });
  return syncStints(next, t);
}

// ---------------------------------------------------------------------------
// Availability (§5.3)
// ---------------------------------------------------------------------------

export function markUnavailable(state, id, reason, nowMs, replacementId = null) {
  const next = clone(state);
  const t = now_(next, nowMs);
  const r = roles(next, t);
  const wasKeeper = id === r.keeperId;
  const wasOnField = r.onFieldIds.includes(id);

  pushUndo(next);
  stopStint(next, id, t);
  getPlayer(next, id).unavailable = { reason, atMs: t };

  let keeperId = r.keeperId;
  let field = r.field.filter((x) => x !== id && x !== replacementId);
  const bench = r.bench.filter((x) => x !== id && x !== replacementId);

  if (wasKeeper) {
    // Someone has to take the gloves: the nominated player, else the last
    // field player, else nobody.
    keeperId = replacementId ?? field.pop() ?? null;
  } else if (wasOnField && replacementId) {
    field = [...field, replacementId];
  }

  rebuild(next, { keeperId, field, bench });
  logEvent(next, { type: 'UNAVAILABLE', off: [id], note: reason });
  if (replacementId) logEvent(next, { type: 'EARLY_SWAP', off: [id], on: [replacementId] });
  return syncStints(next, t);
}

export function returnToRotation(state, id, nowMs) {
  const next = clone(state);
  const t = now_(next, nowMs);
  pushUndo(next);

  const p = getPlayer(next, id);
  p.unavailable = null;
  p.lastOffMs = t;

  const r = roles(next, t);
  // Back onto the bench by playing time, never straight onto the field (§5.3).
  rebuild(next, {
    keeperId: r.keeperId,
    field: r.field.filter((x) => x !== id),
    bench: placeOnBench(next, r.bench.filter((x) => x !== id), id, t),
  });
  logEvent(next, { type: 'RETURN', on: [id] });
  return syncStints(next, t);
}

// ---------------------------------------------------------------------------
// Roster changes
// ---------------------------------------------------------------------------

export function addPlayerMidGame(state, name, credit, nowMs) {
  const next = clone(state);
  const t = now_(next, nowMs);
  pushUndo(next);

  const p = createPlayer(name);
  // §5.4 — a 0-minute player would otherwise pin to the front of the bench and
  // hog the next several rotations.
  p.accumulatedMs = credit === 'average' ? Math.round(meanPlayedMs(next, t)) : 0;
  // A new arrival hasn't come off — they've just turned up. Leaving lastOffMs
  // null keeps them out of the rest guard so they're eligible immediately.
  p.lastOffMs = null;
  next.players.push(p);
  next.order = [...next.order, p.id];

  const r = roles(next, t);
  rebuild(next, {
    keeperId: r.keeperId,
    field: r.field.filter((x) => x !== p.id),
    bench: placeOnBench(next, r.bench.filter((x) => x !== p.id), p.id, t),
  });
  logEvent(next, { type: 'PLAYER_ADDED', on: [p.id], note: credit });
  return syncStints(next, t);
}

export function reorder(state, fromIndex, toIndex, nowMs) {
  const next = clone(state);
  pushUndo(next);
  const [moved] = next.order.splice(fromIndex, 1);
  next.order.splice(toIndex, 0, moved);
  logEvent(next, { type: 'REORDER', note: moved });
  return syncStints(next, now_(next, nowMs));
}

/** §4.6 — re-sort by time played, discarding manual order. */
export function rebalance(state, nowMs) {
  const next = clone(state);
  const t = now_(next, nowMs);
  pushUndo(next);
  const r = roles(next, t);
  // Ties must resolve to existing queue position, so an undisturbed queue is
  // left completely alone. Sorting ascending and reversing would break sort
  // stability and churn equal-time players every single rotation.
  const asc = (a, b) => playedMs(next, a, t) - playedMs(next, b, t);
  const desc = (a, b) => playedMs(next, b, t) - playedMs(next, a, t);
  rebuild(next, {
    keeperId: r.keeperId,
    field: [...r.field].sort(desc), // most played comes off first
    bench: [...r.bench].sort(asc), // least played goes on first
  });
  logEvent(next, { type: 'REBALANCE' });
  return next;
}

// ---------------------------------------------------------------------------
// Fairness analysis
// ---------------------------------------------------------------------------

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * A positional queue only equalises playing time at whole cycle boundaries.
 * With 10 outfield players rotating 3 at a time the queue returns to its
 * starting arrangement after 10 rotations — so a 40-minute game at 5-minute
 * rotations (8 rotations) stops mid-cycle and leaves a 10-minute spread
 * between the most and least played. Nothing is broken; the game just ends
 * partway through the pattern.
 *
 * Picking an interval that divides the game into whole cycles removes the
 * spread entirely, which is the cheapest fix available and costs the coach
 * nothing but a different number in settings.
 */
export function fairnessAdvice(state) {
  const active = state.order.filter((id) => !getPlayer(state, id)?.unavailable);
  const pool = active.length - (state.settings.keeperEnabled ? 1 : 0);
  const k = Math.min(state.settings.subsPerRotation, pool);
  if (pool <= 0 || k <= 0) return null;

  const cycle = pool / gcd(pool, k);
  const totalSeconds = state.settings.totalGameMinutes * 60;
  const current = totalSeconds / state.settings.rotationSeconds;
  const evenlyDivides = Number.isInteger(current) && current % cycle === 0;

  // Whole-cycle rotation counts giving an interval between 2 and 15 minutes.
  const candidates = [];
  for (let m = 1; m * cycle <= totalSeconds / 120; m++) {
    const rotations = m * cycle;
    const seconds = totalSeconds / rotations;
    if (seconds >= 120 && seconds <= 900) candidates.push({ rotations, seconds });
  }
  const best = candidates.sort(
    (a, b) =>
      Math.abs(a.seconds - state.settings.rotationSeconds) -
      Math.abs(b.seconds - state.settings.rotationSeconds)
  )[0];

  const fieldSlots = state.settings.fieldPlayers;
  return {
    cycle,
    rotationsInGame: current,
    evenlyDivides,
    suggestedRotationSeconds: best ? Math.round(best.seconds) : null,
    suggestedRotations: best ? best.rotations : null,
    everyPlayerMinutes: Math.round((totalSeconds * fieldSlots) / pool / 60),
  };
}

/**
 * §4.6 balanced mode. Re-sorts by playing time immediately before each
 * rotation, so selection follows time rather than queue position. Roughly
 * halves the mid-cycle spread at the cost of overriding manual ordering.
 */
export function prepareRotation(state, nowMs) {
  return state.settings.fairnessMode === 'balanced' ? rebalance(state, nowMs) : state;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export const periodLengthMs = (s) =>
  (s.settings.totalGameMinutes * 60 * 1000) / s.settings.periods;

export const msLeftInPeriod = (state, nowMs) =>
  periodLengthMs(state) - now_(state, nowMs);

export const periodOver = (state, nowMs) => msLeftInPeriod(state, nowMs) <= 0;

export const isFinalPeriod = (state) => state.clock.period >= state.settings.periods;

export const gameOver = (state, nowMs) => periodOver(state, nowMs) && isFinalPeriod(state);

export const msUntilRotation = (state, nowMs) =>
  state.settings.rotationSeconds * 1000 - (now_(state, nowMs) - state.clock.lastRotationMs);

/**
 * Whether this period still has room for another rotation.
 *
 * Checking only the time left *right now* against the remainder floor misses
 * the case where the next rotation isn't due yet but, once it lands, won't
 * leave the floor's worth of time behind it — the countdown then keeps
 * ticking past however much of the period is actually left, which reads as
 * "sub due in 5:00" next to a period clock reading 4:00. Looking at where the
 * next rotation would actually land, not just the flat time-remaining
 * snapshot, is what `minRotationRemainderSeconds` is supposed to guard.
 *
 * The forward check only applies before the rotation is due (`until > 0`):
 * once it's overdue, `left` alone already answers whether it's still worth
 * firing, and `left - until` swings positive again for a long-overdue
 * rotation in a period with plenty of time left, which would wrongly say
 * "done" for a period that very much still has subs to give.
 */
export const rotationsDone = (state, nowMs) => {
  const min = state.settings.minRotationRemainderSeconds * 1000;
  const left = msLeftInPeriod(state, nowMs);
  if (left <= min) return true;
  const until = msUntilRotation(state, nowMs);
  return until > 0 && left - until < min;
};

export const rotationDue = (state, nowMs) =>
  msUntilRotation(state, nowMs) <= 0 && !rotationsDone(state, nowMs);

/** Inside the red-button window (§A6c) — used to warn before a swap. */
export const inRedWindow = (state, nowMs) => {
  const left = msUntilRotation(state, nowMs);
  return left <= 10000 && left > 0;
};

export const inAbsorbWindow = (state, nowMs) => {
  const left = msUntilRotation(state, nowMs);
  return left > 0 && left <= state.settings.absorbWindowSeconds * 1000;
};

export function setClockRunning(state, running, nowMs) {
  const next = clone(state);
  next.clock.running = running;
  next.clock.periodElapsedMs = now_(next, nowMs);
  return syncStints(next, next.clock.periodElapsedMs);
}

export function endPeriod(state, nowMs) {
  const next = clone(state);
  const t = now_(next, nowMs);
  next.clock.running = false;
  syncStints(next, t);
  logEvent(next, { type: 'PERIOD_END' });
  return next;
}

/**
 * Second half, and the reason the first half's leftovers don't carry over.
 *
 * A positional queue only comes out even at whole cycle boundaries, so a half
 * that stops mid-cycle leaves some players several minutes up on the rest. If
 * the same eleven simply walk back on, that gap is locked in for the rest of
 * the game — the second half compounds the first half's unfairness instead of
 * correcting it. Re-seeding by playing time is the whole point of having a
 * break: the least-played start, the most-played sit.
 *
 * The keeper is left alone. Who goes in goal is a coaching decision, not a
 * fairness one, and silently swapping keepers at half time would be a nasty
 * surprise on the touchline.
 */
export function startNextPeriod(state, nowMs) {
  const next = clone(state);
  if (next.clock.period >= next.settings.periods) return next;

  // Bank whatever is still running before the clock resets, or a half that was
  // never explicitly ended would lose every on-field stint.
  next.clock.running = false;
  syncStints(next, now_(next, nowMs));

  next.clock.period += 1;
  next.clock.periodElapsedMs = 0;
  next.clock.lastRotationMs = 0;
  next.clock.postponed = false;
  next.pendingRotation = null;
  for (const p of next.players) {
    p.stintStartMs = null;
    p.lastOffMs = null;
    // "Keep them on" is an instruction about the passage of play in front of
    // the coach, not a standing order. The break clears it.
    p.heldOn = false;
  }

  if (next.settings.balanceAtPeriodStart) {
    const r = roles(next, 0);
    const byTimeAsc = [...r.field, ...r.bench].sort(
      (a, b) => playedMs(next, a, 0) - playedMs(next, b, 0)
    );
    const fieldCount = effectiveFieldCount(next);
    rebuild(next, {
      keeperId: r.keeperId,
      // Least played start; within the field the most played go off first, so
      // the queue is already pointing the right way at the first rotation.
      field: byTimeAsc.slice(0, fieldCount).reverse(),
      bench: byTimeAsc.slice(fieldCount),
    });
  }

  logEvent(next, { type: 'PERIOD_START' });
  return syncStints(next, 0);
}

/** Keep a player on the field through scheduled rotations, until released. */
export function toggleHeldOn(state, id, nowMs) {
  const next = clone(state);
  const p = getPlayer(next, id);
  if (!p) return next;
  p.heldOn = !p.heldOn;
  logEvent(next, { type: p.heldOn ? 'HOLD_ON' : 'HOLD_RELEASED', note: p.name });
  return syncStints(next, now_(next, nowMs));
}

export function setScore(state, team, opponent) {
  const next = clone(state);
  next.score = [Math.max(0, team), Math.max(0, opponent)];
  return next;
}

/** A team goal, optionally attributed to a player. Not undo-able like a swap — it's a scoreline correction, not a roster move. */
export function addGoal(state, scorerId, nowMs) {
  const next = clone(state);
  next.score = [next.score[0] + 1, next.score[1]];
  const scorer = scorerId ? getPlayer(next, scorerId) : null;
  next.scorers = [
    ...(next.scorers ?? []),
    { id: scorer?.id ?? null, name: scorer?.name ?? null, atMs: now_(next, nowMs) },
  ];
  return next;
}

/** Corrects a mistaken tap on the goal stepper — drops the matching scorer entry too. */
export function removeLastGoal(state) {
  const next = clone(state);
  if (next.score[0] <= 0) return next;
  next.score = [next.score[0] - 1, next.score[1]];
  next.scorers = (next.scorers ?? []).slice(0, -1);
  return next;
}

/**
 * The single most-underplayed candidate among `ids`, or null when two or
 * more are tied for least. Tagging one arbitrary player "Least time" out of
 * a tie — everyone at 0:00 at kickoff is the common case — reads as a claim
 * the data doesn't support.
 */
export function leastTimeId(state, ids, nowMs) {
  if (!ids.length) return null;
  const times = ids.map((id) => playedMs(state, id, nowMs));
  const min = Math.min(...times);
  const winners = ids.filter((_, i) => times[i] === min);
  return winners.length === 1 ? winners[0] : null;
}

export const formatMs = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

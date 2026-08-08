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
  earlyOffPlacement: 'byTime', // 'byTime' | 'backOfBench' | 'frontOfBench'
  keeperTimeCounts: true,
  pauseGameClockOnDialog: false,
  showFairnessDeviation: true,
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
  };
}

export function createGame(names = [], settings = {}) {
  const players = names.map(createPlayer);
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    players,
    order: players.map((p) => p.id),
    clock: { period: 1, running: false, periodElapsedMs: 0, lastRotationMs: 0 },
    score: [0, 0],
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

/** Signed deviation from squad mean, for the fairness readout (§4.6). */
export const fairnessDeviationMs = (state, id, nowMs) =>
  playedMs(state, id, nowMs) - meanPlayedMs(state, nowMs);

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

  // Rested players first, bench order otherwise preserved. If too few are
  // eligible we still fill the slots — short-handed is worse than under-rested.
  const rested = bench.filter((id) => benchEligible(state, id, nowMs));
  const notRested = bench.filter((id) => !benchEligible(state, id, nowMs));
  const nextIn = [...rested, ...notRested].slice(
    0,
    Math.min(settings.subsPerRotation, bench.length)
  );

  return {
    keeperId,
    field,
    bench,
    nextOff: field.slice(0, Math.min(settings.subsPerRotation, field.length)),
    nextIn,
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

/** §5.6 — restore a full snapshot rather than inverting an operation. */
export function undo(state) {
  if (!state.undoStack.length) return state;
  const next = clone(state);
  const snap = next.undoStack.pop();
  next.order = snap.order;
  next.players = next.players.map((p) => snap.players.find((s) => s.id === p.id) ?? p);
  next.clock = snap.clock;
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

  rebuild(next, {
    keeperId: r.keeperId,
    field: [...r.field.filter((id) => !off.includes(id)), ...on],
    bench,
  });

  next.clock.lastRotationMs = t;
  next.pendingRotation = null;
  logEvent(next, { type: 'ROTATION', off, on });
  return syncStints(next, t);
}

/** Cancelling postpones rather than skips (§5.9, D2b). */
export function postponeRotation(state, nowMs) {
  const next = clone(state);
  next.pendingRotation = null;
  next.clock.lastRotationMs = now_(next, nowMs);
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
    // §4.1 — incoming goes to the back of the field order, so they get a full
    // stint and can never come on and straight back off.
    field: [...r.field.filter((id) => id !== offId), onId],
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

export const msUntilRotation = (state, nowMs) =>
  state.settings.rotationSeconds * 1000 - (now_(state, nowMs) - state.clock.lastRotationMs);

export const rotationDue = (state, nowMs) => msUntilRotation(state, nowMs) <= 0;

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

export function startNextPeriod(state) {
  const next = clone(state);
  if (next.clock.period >= next.settings.periods) return next;
  next.clock.period += 1;
  next.clock.periodElapsedMs = 0;
  next.clock.lastRotationMs = 0;
  next.clock.running = false;
  next.pendingRotation = null;
  for (const p of next.players) {
    p.stintStartMs = null;
    p.lastOffMs = null;
  }
  logEvent(next, { type: 'PERIOD_START' });
  return next;
}

export function setScore(state, team, opponent) {
  const next = clone(state);
  next.score = [Math.max(0, team), Math.max(0, opponent)];
  return next;
}

export const formatMs = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

export const formatSigned = (ms) => `${ms < 0 ? '−' : '+'}${formatMs(Math.abs(ms))}`;

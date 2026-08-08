# Early Swap — Feature Specification

**Feature:** Take a player off (or put one on) outside the scheduled rotation, and have the app adjust the rotation so playing time stays fair.

**Status:** Draft for review. Decisions requiring your call are marked **[D1]**–**[D5]** and collected at the end.

---

## 1. Context and assumptions

Inferred from the prototype screens. Correct anything that's wrong before building.

| # | Assumption |
|---|---|
| A1 | The squad is a single **ordered list**. Position determines everything. |
| A2 | The labels `Keeper` / `Next off` / `On field` / `Next in` / `Substitute` are **derived from position**, not stored on the player. |
| A3 | Slot 0 is the keeper (unless *Disable keeper* is on). Slots 1..`fieldPlayers` are on field. The rest are bench, in the order they'll come on. |
| A4 | `Next off` = the first `subsPerRotation` field players. `Next in` = the first `subsPerRotation` bench players. |
| A5 | A scheduled rotation moves the `Next off` group to the **back of the bench** and the `Next in` group to the **back of the field order**. Everyone shifts up. It's a circular queue. |
| A6 | ✅ **Confirmed.** The `⇄` button triggers the **full scheduled rotation**, via a `Confirm substitution` dialog listing the In and Out groups. This is *not* the same as the new feature. |
| A6b | ✅ **Confirmed.** The same dialog also fires **automatically** when the rotation timer reaches zero. The rotation is therefore *proposed*, never applied without a tap. |
| A6c | The green rotation button counts down and turns **red for the final 10 seconds**. This is a useful hook — see §4.4 and §5.9. |
| A6d | The clocks appear paused while the dialog is open (both timers show `⏸`). Needs a decision — see §5.9. |
| A7 | Each player has a running `secondsPlayed` shown in the right-hand column. |
| A8 | Drag-to-reorder (yellow banner screen) is the coach's manual override of queue position. |

**Worked example of A5**, from the prototype (6 field + keeper, 3 per rotation):

```
Before:  [Dottie*] Val Kora Dylan | Pippa Kit Chanel || Harriet Leni Claudia Amelia
                   ^^^ next off ^^^                     ^^^^ next in ^^^^
After:   [Dottie*] Pippa Kit Chanel | Harriet Leni Claudia || Amelia Val Kora Dylan
```

---

## 2. What the feature is

Three related actions, all reachable by tapping a player row:

1. **Sub off now** — an on-field player comes off ahead of schedule (tired, hurt, sin-binned, parent needs to leave, coach's call).
2. **Sub on now** — a bench player goes on ahead of schedule.
3. **Swap these two** — the two-tap shortcut that does both at once.

Plus the supporting state: **mark unavailable** (injured / gone home) and **return to rotation**.

The design goal is that a coach standing on the sideline in the rain can do this in **two taps**, and that the app silently absorbs the fairness consequences rather than making the coach do arithmetic.

---

## 3. Interaction design

### 3.1 Entry point — revised

**Recommendation changed.** I originally proposed a bottom sheet with a pre-selected replacement. The drag-to-reorder screen argues against it: you already have a **modal list state with a yellow instruction banner**, and coaches will have learned it. Reuse that pattern rather than introducing a second, competing interaction model.

**Tap an on-field player → the list enters swap mode.**

```
┌──────────────────────────────────────────┐
│  Taking Pippa off — tap who comes on  ✕  │  ← yellow banner, same as drag mode
├──────────────────────────────────────────┤
│  Dottie  (Keeper)                  03:20 │  dimmed, not tappable
│  Val     (Next off)                12:40 │  dimmed
│  ...                                     │
│  Pippa   ← coming off              08:15 │  highlighted
│  ...                                     │
│  Harriet (Next in)      Bring on   04:10 │  ← tappable, "Least time" badge
│  Leni    (Next in)      Bring on   05:30 │  ← tappable
│  Claudia                Bring on   06:05 │  ← tappable
└──────────────────────────────────────────┘
```

Second tap executes. **Two taps, both players explicitly chosen, no default to get wrong.**

Why this beats the sheet:

- No hidden default. A pre-selected replacement behind a `›` chevron is either right (and the sheet was overhead) or wrong (and the coach taps through to a picker anyway, making it three taps). Removing the default removes the failure mode.
- You're tapping the actual rows you're already reading, with everyone's playing time visible in context. The sheet took that context away at exactly the moment it mattered.
- It reuses a pattern already in the app.

Tapping a **bench** player enters the mirror mode: `Bringing Claudia on — tap who comes off`, with field players tappable.

Banner has an explicit `✕`. Also exits on tapping the highlighted player again, or after ~10 s of no input.

### 3.2 The other actions — long-press

Swap is the frequent action, so it gets the cheap gesture. Everything else goes in a bottom sheet on **long-press**:

```
│  🧤 Make keeper                   │
│  ⛑  Mark unavailable              │
│  ↑  Move to Next off / Next in    │
│  ↕  Reorder list                  │   ← enters existing drag mode
```

Discoverability: show a one-time coach-mark on first run — `Tap a player to swap · Hold for more`.

### 3.3 Old entry point (superseded, kept for reference)

Tap any player row on the main game screen → bottom sheet opens. The sheet's contents depend on where that player currently sits.

**On-field outfield player** (e.g. Pippa)

```
┌──────────────────────────────────┐
│  Pippa            On field 3:42  │
│  Total played           12:10    │
├──────────────────────────────────┤
│  ↔  Sub off now                  │
│     Harriet comes on        ›    │   ← tap row = execute; tap ›  = change
├──────────────────────────────────┤
│  ↑  Move to Next off             │
│  ⛑  Mark unavailable             │
│  🧤 Make keeper                   │
└──────────────────────────────────┘
```

**Bench player** (e.g. Claudia)

```
│  ↔  Sub on now                   │
│     For Val (longest on field) › │
│  ↑  Move to Next in              │
│  ⛑  Mark unavailable             │
```

**Keeper** — see §5.1, it's a special case.

### 3.2 The default replacement

`Sub off now` pre-selects an incoming player so the common case is two taps. Default = **first player in the bench queue** (the top `Next in`).

Tapping `›` opens the picker: the full bench in queue order, each showing total time played, with a `Least time` badge on the lowest. Unavailable players are listed greyed at the bottom with a `Return to rotation` action.

### 3.3 Two-tap swap shortcut **[D2]**

Long-press (or a `⇄` affordance in the row) puts the list into **swap mode**: the tapped player is highlighted, every other player shows a target state, and the second tap executes. This handles on↔bench, on↔on (reorders the queue only), and bench↔bench (reorders only).

Swap mode times out after ~8 seconds of no input, or on tapping the highlighted player again.

### 3.4 Confirmation and undo

You already confirm the scheduled rotation with a `Confirm substitution` dialog, and that's right for it: six players move at once and the coach hasn't necessarily seen who's in the groups.

**An early swap should not get a second dialog**, because the bottom sheet is already the confirmation — it names both players before anything happens, so the interaction is inherently two-step. Adding a dialog on top makes it three taps for a single-player change and trains the coach to dismiss dialogs without reading them, which then costs you on the rotation dialog where reading actually matters.

So: sheet, then execute. Backed by:

- Haptic tap on execute.
- A toast for 8 seconds: `Pippa off · Harriet on — Undo`.
- `Undo last change` also lives in the ☰ menu, backed by the event log (§6.2), for at least the last 10 actions.

### 3.5 Feedback after the swap

The affected rows animate to their new positions so the coach can see the consequence. If the swap changed who is `Next off`, that row briefly pulses.

---

## 4. The adjustment logic

This is the substance of the feature: where do the two players land in the queue?

### 4.1 Player coming ON early

Insert at the **back of the field order** — i.e. last to come off, a full cycle of pitch time ahead of them.

Rationale: they were at the front of the bench queue because they'd been waiting longest; a full stint is the correct payoff. It also means an early swap never causes a player to come on and then straight back off, which looks broken to parents.

### 4.2 Player coming OFF early

Not the back of the bench. That's what a scheduled rotation does, and it would punish a player for coming off early — exactly backwards if they came off because they rolled an ankle.

**Rule: insert them into the bench queue by playing time, ascending.**

```
insertIndex = first index i in bench where bench[i].secondsPlayed > player.secondsPlayed
              (default: end of bench)
```

So a player who's had very little time returns to the front and goes back on at the next rotation; a player who's had plenty drops back. The queue self-corrects over the next couple of rotations without the coach touching anything.

**Guard — minimum bench rest.** A player who comes off must not be auto-selected as `Next in` until they've been off for `minBenchRest` (default **90 s**, configurable, 0 = disabled). If the insert-by-time rule would put them in the `Next in` group while still inside that window, they are placed immediately *after* it. This stops the "off at 4:50, back on at 5:00" bounce. The coach can still manually override by dragging or by `Sub on now`.

### 4.3 Backfilling the derived labels

Nothing to do — because the labels are derived (A2), removing a player from the `Next off` group automatically promotes the next field player into it. State this as an invariant and it can't drift:

> **Invariant:** after any mutation, `Next off` = first `subsPerRotation` entries of the field segment, `Next in` = first `subsPerRotation` entries of the bench segment, recomputed from scratch.

### 4.4 The rotation timer

Default: **the interval countdown keeps running.** An early swap is an extra event, not a replacement for the scheduled rotation. **[D3]**

**Absorb prompt — revised.** Now that the rotation fires its own dialog automatically, the absorb behaviour moves *earlier* in the flow rather than into the toast. When the coach taps a player to start a swap and the rotation button is **red** (final 10 s), the yellow banner changes before they commit:

> `Rotation due in 8s — swap anyway, or wait?`  `Swap anyway` · `Wait`

`Wait` cancels the swap mode and lets the scheduled rotation dialog do the work in a moment. This is better than the toast version because it intervenes *before* the coach has done something they'll want to undo.

Outside the red window but inside `absorbWindow` (default 60 s), keep the toast option:

> `Pippa off · Harriet on — Undo | Do the full sub now`

### 4.5 Time accounting

- `secondsPlayed` accrues only while a player occupies a field or keeper slot **and** the game clock is running.
- Keeper time counts as playing time by default. **[D4]**
- Unavailable players accrue nothing.
- The stint clock (`On field 3:42`) resets on every entry; total time never resets within a game.

### 4.6 Fairness indicator (recommended, small)

Because the coach can now perturb the queue freely, give them a read on the damage. On each row, next to the total, show a signed deviation from squad mean playing time — `+2:10` / `−1:45` — colour-neutral, small type. Plus one action in the ☰ menu:

**`Rebalance queue by time played`** — re-sorts the bench ascending by `secondsPlayed` and the field segment descending (most-played comes off first), preserving keeper. Shows a preview of the new order with a confirm, since it's destructive of manual ordering.

---

## 5. Edge cases

### 5.1 The keeper comes off early

The keeper slot must stay filled (unless *Disable keeper* is on), so this is a three-way move. On `Sub off now` for the keeper, the sheet asks:

> **Who goes in goal?**
> `Harriet (bench, next in)` · `Choose a field player` · `Play without a keeper`

- **Bench player into goal** — straight swap; outgoing keeper inserts per §4.2.
- **Field player into goal** — that player moves to slot 0; the *outgoing keeper* leaves the field; a bench player (default: top of bench) comes on to fill the vacated field slot. Two incoming movements, one sheet, confirm once.
- **Play without a keeper** — sets *Disable keeper*, field count unchanged; warn that this changes the formation setting.

Same flow applies to `Make keeper` on a field player: it's a keeper↔field swap with no bench involvement.

### 5.2 Empty bench

If every available player is on the field and the coach subs someone off:

> **No players on the bench.** Take Pippa off anyway and play with 5? `Play short` · `Cancel`

`Play short` decrements the effective field count for this period and shows a persistent banner `Playing 5 v 6 — Restore`. Restoring brings the next available player on.

### 5.3 Injury / player leaves

`Mark unavailable` prompts for a reason (`Injured` / `Left early` / `Other`) — optional, one tap to skip. The player:

- leaves the field immediately if on it (triggering the standard early-off replacement flow),
- is removed from the rotation entirely and stops accruing time,
- is shown greyed at the bottom of the list with the reason,
- is excluded from all auto-selection.

`Return to rotation` inserts them per §4.2 (by time played) onto the bench, not straight onto the field.

If unavailability drops the available squad below `fieldPlayers + 1`, fall through to §5.2's play-short handling.

### 5.4 Late arrival / player added mid-game

When a player is added from the Players screen after kick-off, ask how to credit them:

> **When did Amelia arrive?** `Just now — 0 minutes played` · `Match the squad average`

Without this, a 0-minute player pins to the front of the bench under §4.2 and hogs the next several rotations. Default to `Just now` for the first half and `Match the squad average` after the first period. **[D5]**

### 5.5 Swaps while the clock is stopped

Between periods or during a stoppage, an early swap is pure reordering — no time accrues, no absorb prompt. Behaviour is otherwise identical.

### 5.6 Rapid successive swaps

Each is an independent event. The `minBenchRest` guard prevents the pathological case. The undo stack must handle several in a row cleanly, including a swap that has since been partially superseded — undo restores the **full queue snapshot** from before the action rather than attempting an inverse operation. Simpler and always correct.

### 5.9 The rotation fires while a swap is in progress

Because the rotation dialog now appears on its own, two modals can collide. **Never let the rotation dialog appear under the coach's thumb mid-tap** — that's how the wrong three players get subbed.

Rules:

1. If swap mode or the long-press sheet is open when the rotation timer hits zero, **defer** the dialog. Don't stack, don't steal focus.
2. The rotation countdown holds at `00:00` and the button stays red rather than resetting.
3. The moment the swap completes or is cancelled, present the rotation dialog — recomputed from the *post-swap* state, so the names are correct.
4. If the completed swap already moved a player who was in the pending `Next off` group, the dialog's groups reflect the backfill automatically (§4.3).

**Pending-rotation state.** Because the rotation needs a tap, it can sit unactioned indefinitely — coach is talking to a parent, phone is in a pocket. Handle it explicitly:

- Do **not** auto-apply after a timeout. Silently subbing three players without the coach seeing it is worse than a late sub.
- The button stays red and switches label to `Sub now (3)`, so a dismissed dialog is still visibly pending.
- Cancelling the dialog postpones rather than skips: recommend restarting the interval from zero, so the next prompt is a full interval away rather than immediately re-firing. Add a `Skip this rotation` option if you want an explicit skip.

### 5.10 What the clocks do while the dialog is open

Currently both appear to pause. I'd split them:

| Clock | Recommendation | Why |
|---|---|---|
| **Game clock** (`19:25`) | **Keep running** | It should mirror the referee's watch. If it pauses every rotation and the coach takes 20 s to tap OK, you lose several minutes across a game and the period ends late. |
| **Rotation countdown** (`04:45`) | **Hold at zero** | It has nothing to count until the sub is applied. |
| **Playing time** | **Keeps accruing to the players currently on the field** | They *are* still on the field until someone taps OK. This is simply accurate. |

The same applies while swap mode is open — the game doesn't stop because the coach is looking at their phone.

If you'd rather the whole thing pause (some coaches use the app as the official clock in unrefereed age groups), make it the setting `pauseGameClockOnDialog`, default **off**.

### 5.7 A player is dragged while a swap sheet is open

Dismiss the sheet on any list mutation. Don't attempt to reconcile.

### 5.8 Period change

At period end, all stint clocks stop and reset; queue order carries over unchanged into the next period. An early swap in the dying seconds of a period should trigger the absorb prompt only if a rotation is genuinely still pending in that period.

---

## 6. Data model

### 6.1 Player

```ts
type PlayerStatus = 'keeper' | 'field' | 'bench' | 'unavailable';

interface Player {
  id: string;
  name: string;
  status: PlayerStatus;      // derived from queue position, except 'unavailable'
  queueIndex: number;        // single source of truth for rotation order
  secondsPlayed: number;     // cumulative, this game
  stintStartedAt: number | null;  // game-clock ms, null when off
  lastOffAt: number | null;       // game-clock ms — drives minBenchRest
  unavailable?: { reason: 'injured' | 'left' | 'other'; at: number };
  creditedSeconds?: number;  // for mid-game joins, §5.4
}
```

### 6.2 Event log

Needed for undo, for the post-game summary, and for debugging "the app put her on twice" conversations on the sideline.

```ts
interface GameEvent {
  id: string;
  at: number;                // game-clock ms
  wallClock: number;
  type: 'ROTATION' | 'EARLY_OFF' | 'EARLY_ON' | 'SWAP'
      | 'KEEPER_CHANGE' | 'UNAVAILABLE' | 'RETURN'
      | 'PERIOD_START' | 'PERIOD_END' | 'GOAL' | 'REORDER';
  off: string[];             // player ids
  on: string[];
  note?: string;
  snapshotBefore: string[];  // full ordered player-id array, for undo
}
```

### 6.3 Settings additions

| Setting | Type | Default |
|---|---|---|
| `minBenchRest` | seconds, 0–180 | 90 |
| `absorbWindow` | seconds, 0–120 | 60 |
| `earlyOffPlacement` | `byTime` \| `backOfBench` \| `frontOfBench` | `byTime` |
| `resetTimerOnEarlySwap` | bool | false |
| `keeperTimeCounts` | bool | true |
| `showFairnessDeviation` | bool | true |

---

## 7. Core algorithm (pseudocode)

```ts
function earlyOff(offId: string, onId: string | null, now: number) {
  const snapshot = queue.map(p => p.id);

  const off = getPlayer(offId);
  if (off.status === 'keeper') return keeperOffFlow(off, now);   // §5.1

  const incoming = onId ? getPlayer(onId) : firstAvailableBenchPlayer();
  if (!incoming) return promptPlayShort(off);                    // §5.2

  // 1. stop the outgoing player's clock
  off.secondsPlayed += now - off.stintStartedAt;
  off.stintStartedAt = null;
  off.lastOffAt = now;

  // 2. start the incoming player's clock
  incoming.stintStartedAt = now;

  // 3. remove both from the queue
  removeFromQueue(off.id, incoming.id);

  // 4. incoming goes to the back of the field segment  (§4.1)
  insertAt(incoming, fieldSegmentEnd());

  // 5. outgoing inserts into the bench by time played  (§4.2)
  let idx = benchIndexByPlayingTime(off.secondsPlayed);
  idx = applyMinBenchRestGuard(idx, off, now);
  insertAt(off, idx);

  // 6. labels are recomputed, never stored  (§4.3)
  recomputeDerivedRoles();

  logEvent({ type: 'EARLY_OFF', off: [off.id], on: [incoming.id], at: now, snapshotBefore: snapshot });
  showToast(off, incoming, /* offerAbsorb */ timeToNextRotation() <= settings.absorbWindow);
}

function benchIndexByPlayingTime(seconds: number): number {
  const bench = queue.slice(benchStart());
  const i = bench.findIndex(p => p.secondsPlayed > seconds);
  return benchStart() + (i === -1 ? bench.length : i);
}

function applyMinBenchRestGuard(idx: number, player: Player, now: number): number {
  const nextInEnd = benchStart() + settings.subsPerRotation;
  const rested = now - (player.lastOffAt ?? 0);
  if (idx < nextInEnd && rested < settings.minBenchRest * 1000) return nextInEnd;
  return idx;
}
```

`earlyOn(onId)` is the mirror image: pick the longest-serving field player as the default outgoing, then call `earlyOff` with the pair.

---

## 8. Acceptance criteria

```gherkin
Scenario: Basic early swap
  Given Pippa is on field and Harriet is first on the bench
  When I tap Pippa and choose "Sub off now"
  Then Harriet is on the field, last in the field order
  And Pippa is on the bench, positioned by her total playing time
  And the rotation countdown has not reset
  And an undo toast is shown

Scenario: Next-off group backfills
  Given Val, Kora and Dylan are "Next off"
  When Kora is subbed off early
  Then the next field player in the order is labelled "Next off"
  And exactly 3 players are labelled "Next off"

Scenario: No immediate bounce-back
  Given minBenchRest is 90 seconds
  And Pippa has the least playing time in the squad
  When Pippa is subbed off early
  And a scheduled rotation occurs 20 seconds later
  Then Pippa does not come back on

Scenario: Absorb into the scheduled rotation
  Given the rotation countdown reads 0:40 and absorbWindow is 60 seconds
  When I sub Pippa off early
  Then the toast offers "Do the full sub now"
  And choosing it performs the full rotation and resets the countdown

Scenario: Keeper off early, field player takes the gloves
  When I sub the keeper off and choose Chanel to go in goal
  Then Chanel occupies the keeper slot
  And the outgoing keeper is on the bench
  And one bench player has come on to the field
  And the field player count is unchanged

Scenario: Empty bench
  Given every available player is on the field
  When I sub a player off early
  Then I am warned and offered "Play short"
  And accepting shows a persistent "playing short" banner

Scenario: Injured player
  When I mark Leni unavailable with reason "Injured"
  Then Leni leaves the field and stops accruing time
  And Leni is excluded from all auto-selection
  And "Return to rotation" places Leni on the bench, not the field

Scenario: Undo
  When I perform three early swaps and undo twice
  Then the queue matches the state before the second swap
  And playing times match that state
```

---

## 9. Getting the game onto the sub-runner's phone

### 9.1 Separate the two problems

These get conflated and they have wildly different costs:

| | Problem | Who needs it | Cost |
|---|---|---|---|
| **P1 — Handoff** | Get the squad, settings and starting lineup onto whichever phone is running subs today. One direction, before kick-off. | Every team, every week. | Low |
| **P2 — Live sync** | Two or more phones watching or driving the same running game. | A minority — clubs with an assistant, or a coach who wants to glance at times mid-game. | High |

**P1 is the actual requirement.** Solve it properly and standalone, and only then decide whether P2 earns its keep. Most of the value is in the parent not having to type eleven names into a phone at 8:40 on a Saturday.

### 9.2 The binding constraint

Junior grounds have poor mobile coverage. Any design where the app needs the network *during* the game is broken by definition — the sub runner will be standing in a paddock in Bannockburn with one bar.

> **Non-negotiable:** local state is authoritative. The game runs fully offline. Any sync is opportunistic and never blocks an action.

This rules out anything that treats the server as the source of truth mid-game, and it strongly favours transfer mechanisms that don't need connectivity at all.

### 9.3 Recommended mechanism: encoded state, delivered by QR or link

Serialise the game state to a compact string and move it between devices with no backend:

```
gzip(JSON) → base64url → https://subs.app/#g=eyJ2IjoxLCJzIjpb...
```

Deliver it two ways from the same payload:

- **QR code** — coach's phone displays it, parent scans with the camera app. Works with **zero connectivity** if the app is already installed/cached. This is the primary path and it's the one that'll actually get used at the ground.
- **Share link** — the same URL via SMS, WhatsApp or the team group chat, for sending the squad the night before.

**One mechanism, three jobs.** The same encode/decode handles:

1. **Pre-game handoff** — squad + settings + lineup → parent's phone.
2. **Mid-game device transfer** — if the parent's phone dies or they have to leave, the current state (including everyone's accumulated time) goes to another phone by scanning. Put `Transfer to another phone` in the ☰ menu, showing a live QR.
3. **Post-game report back** — the finished game, with playing times, back to the coach.

Payload size is not a constraint: 15 players with names and elapsed seconds, plus settings, compresses to a few hundred bytes — comfortably inside QR capacity even at high error correction, which you want for a phone screen being scanned in sunlight.

```ts
interface TransferPayload {
  v: 1;                        // schema version — reject unknown, don't guess
  t: 'setup' | 'live' | 'report';
  team?: string;
  settings: GameSettings;
  players: Array<[name: string, secondsPlayed: number, status: 0|1|2|3]>;  // tuples, not objects
  clock?: { period: number; elapsed: number; sinceRotation: number };
  score?: [number, number];
  created: number;
}
```

Version the payload from day one and refuse to import a version you don't recognise, with a `This link is from a newer version of the app — update to open it` message. Otherwise your first schema change silently corrupts someone's game.

Guard the import: if a live game is already running on the receiving phone, warn before overwriting — `You have a game in progress. Replace it?`

### 9.4 If you do build live sync (P2)

Only after P1 is solid. The essential design decision is **authority**, and the answer is a single-writer model:

- Exactly one device holds the **controller** token at any time. Everyone else is read-only.
- Read-only devices see the list, times and clock, but every action control is hidden — not disabled-looking, hidden. A greyed button that a parent taps repeatedly is worse than no button.
- A viewer can `Request control`; the controller gets a prompt and grants it. Handover is explicit and atomic.
- Controller writes its full state snapshot every ~5 s and after every event; viewers subscribe. Last write from the controller wins, unconditionally.

This deliberately avoids merge logic. Two phones both running the sub clock and reconciling divergent event streams is a genuinely hard distributed-systems problem, and it is not worth solving for a Saturday morning under-10s game. Single-writer makes conflict structurally impossible.

Supabase Realtime on a `games` table keyed by a short join code is the obvious fit given your stack. Anonymous, code-based, no accounts — the parent running subs changes week to week and any login step will kill adoption.

**Offline behaviour must be explicit:** if the controller loses connection, it keeps running normally and queues snapshots. Viewers show a `Last updated 2 min ago` staleness banner rather than freezing or showing stale data as if it were live.

### 9.5 The higher-value adjacent feature

Worth flagging because it may beat live sync on value-per-hour: **persistent team profiles.** Save the squad once, and every subsequent week starts from `Load team: U10 Blues` rather than re-entering names. Combined with §9.3's QR handoff, the parent's Saturday becomes: scan, tap start.

That's local storage plus an optional cloud backup, and it's a fraction of the work of P2.

### 9.6 Two things that will bite you regardless of device count

- **Screen lock.** A phone that sleeps mid-game stops being useful and may suspend your timers. Use the [Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) while a game is running, re-acquire on `visibilitychange`, and never trust `setInterval` for elapsed time — store timestamps and compute elapsed from `Date.now()` on resume, or a backgrounded tab will silently lose minutes.
- **Refresh/crash durability.** Persist the full game state locally on every event, not on a timer. The sub runner accidentally closing the tab must not lose the game.

*(This section assumes the app is a web app / PWA. If it's native, the QR approach still works via a deep link, and the wake-lock and persistence points still apply.)*

---

## 10. Deployment and architecture

### 10.1 Vercel — yes, and it's a good fit

The app is a static SPA/PWA with no server-side logic. Vercel's static hosting handles it with no config beyond a SPA rewrite. No serverless functions, no edge middleware, no runtime.

One licensing note: the Hobby tier is non-commercial. Fine for a club app; if you ever charge for it, you need Pro.

### 10.2 Supabase — not needed

Nothing in this spec requires a database. Everything is device-local, and the handoff mechanism (§9.3) deliberately moves state as an encoded payload rather than through a server.

What *would* need a backend, and why none of it is in v1:

| Would need Supabase | Status |
|---|---|
| Live multi-device sync (§9.4) | Deferred — **D6** |
| Rosters synced across the coach's and the parent's phones independently | Covered more cheaply by QR handoff |
| Season-long stats across games and devices | Out of scope (§11) |
| Accounts, club administration | Out of scope |

Adding a database now would buy you nothing and cost you the offline guarantee, since it's very easy to accidentally make a read path depend on the network.

### 10.3 The service worker is the load-bearing piece

§9.2 requires the app to run with no signal. On Vercel, that means a service worker precaching the app shell — without one, a parent at a ground with no coverage gets a browser error page and the game doesn't happen.

Two rules:

1. **Never auto-reload on update.** A service worker that calls `skipWaiting()` and reloads mid-game will destroy a live game. Detect the waiting worker, hold it, and only prompt (`Update available — restart`) when **no game is in progress**. Apply silently on next cold start otherwise.
2. **Version the cache** and treat the app shell as immutable-with-hashed-filenames so a stale shell can't pair with fresh assets.

### 10.4 The one real risk with going backend-free

Safari deletes script-writable storage — <cite index="2-1">IndexedDB, localStorage, sessionStorage and service worker registrations</cite> — after seven days without user interaction on the site. **Your app is used once a week.** That sits exactly on the boundary: a parent who opens it in Safari on Saturday and doesn't touch it again may find the roster gone by the following Saturday.

The exemption is the important part: <cite index="7-1">web apps added to the home screen sit outside Safari and keep their own days-of-use counter</cite>, so an installed PWA is not subject to the seven-day tally. Apple's position is that <cite index="2-1">home-screen apps are exempt, though the documented specifics are thin</cite>.

Mitigations, cheapest first:

1. **Prompt to add to home screen** during setup, and make it a genuine step rather than a dismissible hint. This is the actual fix, and it also gets you standalone display and a better wake-lock story. iOS needs a manual instruction card (no `beforeinstallprompt`).
2. **Call `navigator.storage.persist()`** on launch. Reliable on Chrome; on iOS it's undocumented whether it outranks ITP, and it must be re-requested each session — so treat it as belt-and-braces, not the fix.
3. **Make the roster recoverable by link.** The §9.3 payload already does this: `Save team link` produces a URL the coach keeps in their notes or the team chat. If storage is ever wiped, one tap restores everything. This is the cheapest possible durability guarantee and it needs no backend.
4. **Degrade honestly.** On launch with no stored team, don't show an empty state that looks like a fresh install — show `No saved team — restore from a link or start fresh`.

If (3) proves annoying in practice, *that* is the trigger for adding Supabase — a single anonymous `teams` table for roster durability only, with the game itself still running fully local. That's a much smaller commitment than live sync and worth keeping in your back pocket.

---

## 11. Decisions for you

| | Decision | Recommendation |
|---|---|---|
| **D1** | Positional queue vs continuous time-balanced sorting as the underlying mechanic. | **Keep the positional queue.** It's predictable, it's what drag-to-reorder edits, and coaches can see what's coming. Use `byTime` insertion on early swaps plus the optional `Rebalance` action to get most of the fairness benefit without the list reshuffling under the coach's thumb. |
| **D2** | ~~Bottom sheet vs swap mode.~~ **Revised** — see §3.1. | **List-based swap mode as the primary interaction**, reusing your yellow-banner pattern; long-press for the rarer actions. Two taps, no hidden default, no second interaction model to learn. |
| **D2b** | Does cancelling the rotation dialog skip or postpone? | **Postpone**, restarting the interval. A skip that silently costs a player five minutes is hard to notice and hard to explain to a parent. Offer explicit `Skip` if needed. |
| **D2c** | Does the game clock pause while a dialog is open? | **No** — see §5.10. Make it a setting if you want it as the official clock in unrefereed grades. |
| **D3** | Does an early swap reset the rotation countdown? | **No**, with the absorb prompt as the escape hatch. Resetting makes the interval meaningless if the coach swaps often. |
| **D4** | Does keeper time count toward playing time? | **Yes** by default, but expose the toggle — plenty of clubs rotate the gloves and treat keeper minutes as a separate fairness pool. |
| **D5** | How to credit a mid-game arrival. | Ask, don't guess. It's one tap and getting it wrong distorts the whole second half. |
| **D6** | Handoff only, or live multi-device sync? | **Handoff only** (§9.3) for now. It's a day's work, needs no backend, works with no signal, and covers the actual complaint. Revisit live sync after a season of use — you may find nobody asks for it. |
| **D7** | Team profiles before or after the early-swap feature? | Arguably **before**. It's less work and removes more Saturday-morning friction than anything else on this list. |

---

## 12. Out of scope (worth listing so it doesn't creep)

- Positions on the field (defender/mid/forward) and position-aware substitution.
- Formation view / pitch diagram.
- Multi-game season fairness tracking.
- Live multi-device sync (§9.4) — deferred, not abandoned.
- Accounts, logins, club administration.
- Opposition or referee events beyond the existing score dialog.

Positions are the obvious next one, and it's worth noting now that adding them changes §4 substantially — the incoming player would need to be filtered by the vacated position. Nothing in this spec blocks that, but `earlyOff` would grow a `positionFilter` argument.

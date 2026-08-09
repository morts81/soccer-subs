# Soccer Subs

Fair substitutions and playing time for junior soccer. Offline-first React PWA, no backend.

```bash
npm install
npm run dev      # local
npm test         # 31 engine tests
npm run build    # → dist/
```

Deploy: import the repo into Vercel, framework preset **Vite**, build `npm run build`, output `dist`. `vercel.json` handles the SPA rewrite and stops `sw.js` being cached. Nothing else to configure — no environment variables, no database.

## Layout

| Path | What it is |
|---|---|
| `src/engine/rotation.js` | The whole rotation model. Pure functions, no React, no timers, no storage. |
| `src/engine/rotation.test.js` | The spec's acceptance criteria, executable. |
| `src/engine/transfer.js` | QR/link payload — encode, decode, version guard. |
| `src/engine/persistence.js` | localStorage with honest failure, plus the iOS install checks. |
| `src/hooks/useGameClock.js` | Timestamp-based clock and wake lock. |
| `src/components/` | UI only. No rotation logic lives here. |

`rotation.js` has no imports. If you'd rather keep your existing prototype UI, lift that one file and the tests — everything else is replaceable.

## How the rotation works

One ordered list. Position determines everything, and `Keeper` / `Next off` / `On field` / `Next in` / `Substitute` are recomputed from position on every render — never stored. That single decision removes a whole category of bug: a player can't be labelled "Next off" while sitting on the bench, because the label isn't a thing that can go stale.

A scheduled rotation moves the next-off group to the bench and the next-in group to the back of the field. An early swap does the same for one player, except the outgoing player rejoins the bench **by playing time** rather than at the back — so coming off early doesn't cost a kid their place in the queue.

## Three things worth knowing before you change anything

**1. The queue only comes out even at whole cycle boundaries.**

With 10 outfield players rotating 3 at a time, the queue returns to its starting arrangement after 10 rotations. A 40-minute game at 5-minute rotations contains 8. So it stops two rotations short, and the spread between most- and least-played is **10 minutes**.

Measured, on the default settings:

| Setup | Spread |
|---|---|
| 8 rotations of 5:00 (the prototype defaults) | 10:00 |
| 10 rotations of 4:00 | 0:00 |
| 8 rotations, balanced mode | 5:00 |
| 10 rotations, balanced mode | 10:00 |

The fix is free: pick an interval that divides the game into whole cycles. `fairnessAdvice()` computes this and the settings screen offers it as a one-tap correction.

Note the last row. **Time-balanced selection is worse than the plain queue when the queue is well configured** — greedy per-rotation choices don't beat a schedule that's already periodic. That's why `fairnessMode` defaults to `queue` and balanced isn't surfaced in the UI. It's kept in the engine because it does help when the interval can't be changed.

**2. An early swap costs about one stint, and only to the two players involved.**

After one early swap across a full game, eight of ten outfield players still land exactly on the mean. The incoming player gains roughly a stint, the outgoing loses part of one. That's explicable to a parent, which matters more than it sounds. The by-time bench insertion is what keeps it contained — remove it and the imbalance persists for the rest of the game.

**3. The rest guard belongs at rotation time, not at insertion time.**

A player who comes off early always has zero rest at the moment they hit the bench. Testing eligibility when placing them pushes *every* early-off player to the back regardless of playing time — the exact unfairness the by-time rule exists to prevent. `benchEligible()` is therefore consulted when picking who comes on, not when deciding where someone sits. This was a bug in the spec before it was a bug in the code.

## Deliberate behaviours that look like bugs

- **The game clock keeps running while dialogs are open.** It should match the referee's watch. Pausing it every rotation loses several minutes across a game. `pauseGameClockOnDialog` turns it on for unrefereed grades.
- **The rotation dialog is deferred, not stacked.** If a swap is in progress when the timer hits zero, the countdown holds at `00:00`, the button goes red, and the dialog waits. A dialog appearing under a thumb mid-tap is how the wrong three players get subbed.
- **Cancelling the rotation postpones it — the countdown keeps running, it does not restart.** It doesn't skip either: the sub just stays due (the button stays red) until the coach taps it again, instead of silently costing a kid five minutes or nagging the dialog back open every quarter-second.
- **Undo restores a full snapshot** rather than inverting the last operation. Simpler and always correct, including after several rapid swaps. The wall clock is the exception — `periodElapsedMs` comes from the current state, not the snapshot, so undoing a swap can't make the displayed game clock jump backwards.
- **A returning injured player goes to the bench, never straight onto the field.**
- **"Players swapped each time" defaults to the bench size**, not a fixed number — 6 + keeper on the pitch out of a 9-player squad defaults to swapping 2, the whole bench, each rotation. Touch the slider yourself and the default stops following squad or field-size changes; `subsPerRotationAuto` tracks whether you have.

## Storage

Safari clears script-writable storage after seven days without interaction, and this app is used once a week — right on the boundary. Home-screen installs are exempt, so the setup screen prompts iOS users to install rather than treating it as optional. `navigator.storage.persist()` is requested as well, though it's undocumented whether it outranks ITP on iOS.

The real durability guarantee is the squad link. Keep one in the team chat and any wipe is a one-tap recovery.

## Handover

The transfer screen renders a QR containing the whole game — squad, settings, and every minute played. The other phone scans it with the **native camera app**, so there's no in-app scanner and no connectivity needed. A 15-player mid-game payload is ~470 characters, comfortably inside QR level H.

The payload is versioned and a newer schema is refused rather than guessed at. Change the shape, bump `SCHEMA_VERSION`.

## Not built

Live multi-device sync, positions, season stats, accounts. Live sync in particular is deferred deliberately — see §9.4 of the spec. If it's ever built, the design decision that matters is single-writer authority with explicit handover, not merge logic.

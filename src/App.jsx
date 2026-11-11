import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as E from './engine/rotation.js';
import { decodeGame, readIncomingLink, TransferError } from './engine/transfer.js';
import * as store from './engine/persistence.js';
import { useGameClock, useWakeLock } from './hooks/useGameClock.js';
import { useServiceWorkerUpdate } from './hooks/useServiceWorkerUpdate.js';
import PlayerRow from './components/PlayerRow.jsx';
import {
  ConfirmDialog,
  GoalScorerSheet,
  KeeperSheet,
  PlayerSheet,
  ReasonSheet,
  RotationDialog,
  ScoreDialog,
  Toast,
} from './components/Dialogs.jsx';
import {
  LineupScreen,
  PlayersScreen,
  SettingsScreen,
  TransferScreen,
} from './components/Screens.jsx';

export default function App() {
  const [game, setGame] = useState(null);
  const [teamName, setTeamName] = useState('');
  const [screen, setScreen] = useState('game');
  const [setupError, setSetupError] = useState(null);

  // Transient UI. Deliberately not persisted — a refresh should never leave a
  // half-finished swap on screen.
  const [swap, setSwap] = useState(null); // { fromId, direction }
  const [sheet, setSheet] = useState(null); // { kind, id }
  const [toast, setToast] = useState(null);
  const [showScore, setShowScore] = useState(false);
  const [redWarning, setRedWarning] = useState(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [lastActionLabel, setLastActionLabel] = useState(null);
  // "Later" hides the banner only for the screen it was tapped on, so it comes
  // back when the coach moves around rather than staying buried all session.
  const [updateDismissedOn, setUpdateDismissedOn] = useState(null);
  const bootedAt = useRef(Date.now());

  const { needRefresh, applyUpdate } = useServiceWorkerUpdate();
  const updateScreen = game ? screen : 'setup';

  // A new build found moments after opening the app, with no game on the go,
  // can't cut anything off — apply it now instead of waiting for a tap nobody
  // notices. Anything later (or any saved game) still goes through the banner.
  useEffect(() => {
    if (needRefresh && !game && Date.now() - bootedAt.current < 15000) applyUpdate();
  }, [needRefresh, game, applyUpdate]);

  const updateBanner = needRefresh && updateDismissedOn !== updateScreen ? (
    <Toast
      message="A new version is ready — updating reloads the app, so do it between games."
      actions={[
        ['Update', applyUpdate],
        ['Later', () => setUpdateDismissedOn(updateScreen)],
      ]}
    />
  ) : null;

  const toastTimer = useRef(null);

  /* ---- boot ------------------------------------------------------------ */

  useEffect(() => {
    store.requestPersistence();
    const incoming = readIncomingLink();
    if (incoming) {
      try {
        const { state, teamName: name } = decodeGame(incoming);
        setGame(state);
        setTeamName(name);
        return;
      } catch (err) {
        setSetupError(
          err instanceof TransferError ? err.message : 'That link could not be opened.'
        );
      }
    }
    const saved = store.loadGame();
    if (saved) setGame(saved);
  }, []);

  useEffect(() => {
    if (game) store.saveGame(game);
  }, [game]);

  /* ---- clock ----------------------------------------------------------- */

  const modalOpen = Boolean(
    game?.pendingRotation || sheet || swap || confirmUndo || confirmPause
  );
  const clockRunning =
    Boolean(game?.clock.running) &&
    !(game?.settings.pauseGameClockOnDialog && modalOpen);

  // §5.10 — the game doesn't stop because the coach is looking at their phone.
  // Capped at the period length so nothing — the period clock, playing time,
  // the stint timers — reads past the whistle, even for the moment between
  // the clock crossing zero and the auto-stop below landing (or after the
  // phone wakes from a pocket well past the end of the half).
  const rawNowMs = useGameClock(clockRunning, game?.clock.periodElapsedMs ?? 0);
  const periodEndMs = game ? E.periodLengthMs(game) : Infinity;
  const nowMs = Math.min(rawNowMs, periodEndMs);
  useWakeLock(Boolean(game?.clock.running));

  const commit = useCallback((next, ms) => {
    setGame({ ...next, clock: { ...next.clock, periodElapsedMs: ms } });
  }, []);

  /* ---- half time / full time ------------------------------------------- */

  // The clock stops itself at the end of each period. Left running, playing
  // time kept accruing for everyone on the field through the break, which
  // skewed the second-half re-seed and the final totals.
  useEffect(() => {
    if (!game?.clock.running || !E.periodOver(game, nowMs)) return;
    commit(E.endPeriod(game, periodEndMs), periodEndMs);
    navigator.vibrate?.([200, 100, 200]);
  }, [game, nowMs, periodEndMs, commit]);

  /* ---- rotation firing (§5.9) ------------------------------------------ */

  const rotationDue = game ? E.rotationDue(game, nowMs) : false;
  const blocked = Boolean(swap || sheet || showScore || confirmUndo || confirmPause);

  useEffect(() => {
    if (!game || !game.clock.running) return;
    // Defer rather than stack: a dialog must never appear under a thumb that is
    // mid-tap on a swap.
    if (rotationDue && !game.pendingRotation && !blocked) {
      setGame((g) => (g ? E.proposeRotation(E.prepareRotation(g, nowMs), nowMs) : g));
    }
  }, [rotationDue, blocked, game?.pendingRotation, game?.clock.running, nowMs]);

  const flash = (message, actions = []) => {
    clearTimeout(toastTimer.current);
    setToast({ message, actions });
    toastTimer.current = setTimeout(() => setToast(null), 8000);
  };

  /* ---- actions --------------------------------------------------------- */

  const roles = useMemo(() => (game ? E.roles(game, nowMs) : null), [game, nowMs]);

  const targets = useMemo(() => {
    if (!game || !swap) return [];
    // The keeper never appears as an ordinary swap target — bringing someone
    // on for them is a three-way move handled by the dedicated keeper sheet
    // (§5.1), not this two-tap flow.
    return swap.direction === 'off' ? roles.bench : roles.onFieldIds.filter((id) => id !== roles.keeperId);
  }, [game, swap, roles]);

  const leastTimeId = useMemo(
    () => (game ? E.leastTimeId(game, targets, nowMs) : null),
    [targets, game, nowMs]
  );

  const beginSwap = (id) => {
    const role = E.roleOf(game, id, nowMs);
    if (role === 'unavailable') return setSheet({ kind: 'player', id });
    if (role === 'keeper') return setSheet({ kind: 'keeper' });

    const onField = ['field', 'nextOff'].includes(role);
    if (onField && roles.bench.length === 0) {
      return flash('Nobody on the bench to bring on.');
    }
    // §4.4 — intervene before the coach commits, not after. Once a rotation
    // is actually due (not just close), inRedWindow alone stops catching it —
    // it turns off at zero, right when starting a swap now guarantees the
    // full rotation dialog will land the instant this one closes. Warn there
    // too, or the coach gets blindsided by a second dialog for players they
    // didn't touch.
    if (E.inRedWindow(game, nowMs) || E.rotationDue(game, nowMs)) {
      setRedWarning(id);
      return undefined;
    }
    setSwap({ fromId: id, direction: onField ? 'off' : 'on' });
    return undefined;
  };

  const completeSwap = (targetId) => {
    const offId = swap.direction === 'off' ? swap.fromId : targetId;
    const onId = swap.direction === 'off' ? targetId : swap.fromId;
    const offName = E.getPlayer(game, offId).name;
    const onName = E.getPlayer(game, onId).name;

    const next = E.earlySwap(game, offId, onId, nowMs);
    commit(next, nowMs);
    setSwap(null);
    setLastActionLabel(`${offName} off, ${onName} on`);
    navigator.vibrate?.(18);

    const actions = [['Undo', () => setGame((g) => E.undo(g, nowMs))]];
    if (E.inAbsorbWindow(next, nowMs)) {
      actions.push([
        'Do the full sub now',
        () => setGame((g) => E.proposeRotation(E.prepareRotation(g, nowMs), nowMs)),
      ]);
    }
    flash(`${offName} off, ${onName} on`, actions);
  };

  const handleSheetAction = (action, id) => {
    setSheet(null);
    if (action === 'return') {
      const name = E.getPlayer(game, id).name;
      commit(E.returnToRotation(game, id, nowMs), nowMs);
      setLastActionLabel(`${name} back in the rotation`);
      flash(`${name} is back in the rotation`);
    } else if (action === 'keeper') {
      const name = E.getPlayer(game, id).name;
      commit(E.swapKeeperWithField(game, id, nowMs), nowMs);
      setLastActionLabel(`${name} in goal`);
      flash(`${name} is in goal`);
    } else if (action === 'hold') {
      const { name, heldOn } = E.getPlayer(game, id);
      commit(E.toggleHeldOn(game, id, nowMs), nowMs);
      setLastActionLabel(heldOn ? `${name} released` : `${name} held on`);
      flash(heldOn ? `${name} will rotate again` : `${name} stays on until you release them`);
    } else if (action === 'moveTo') {
      const name = E.getPlayer(game, id).name;
      const from = game.order.indexOf(id);
      const onField = ['field', 'nextOff'].includes(E.roleOf(game, id, nowMs));
      const to = onField ? (game.settings.keeperEnabled ? 1 : 0) : roles.bench.length
        ? game.order.indexOf(roles.bench[0])
        : from;
      commit(E.reorder(game, from, to, nowMs), nowMs);
      setLastActionLabel(`${name} moved to the front`);
      flash(onField ? `${name} will sub off next` : `${name} will come on next`);
    } else if (action === 'moveToBack') {
      const name = E.getPlayer(game, id).name;
      const onField = ['field', 'nextOff'].includes(E.roleOf(game, id, nowMs));
      commit(E.moveToBack(game, id, nowMs), nowMs);
      setLastActionLabel(`${name} moved to the back`);
      flash(onField ? `${name} will be the last to sub off` : `${name} will be the last to come on`);
    } else if (action === 'unavailable') {
      setSheet({ kind: 'reason', id });
    }
  };

  /* ---- screens --------------------------------------------------------- */

  if (!game) {
    return (
      <>
        <LineupScreen
          savedTeam={store.loadTeam()}
          error={setupError}
          onRestore={() => setSetupError('Open the link your coach sent and it will load here.')}
          onStart={(playingNames, name, fullRoster) => {
            store.saveTeam({ name, names: fullRoster });
            setTeamName(name);
            const subsPerRotation = E.defaultSubsPerRotation(playingNames.length, E.DEFAULT_SETTINGS);
            setGame(E.createGame(playingNames, { subsPerRotation }));
            setScreen('game');
          }}
        />
        {updateBanner}
      </>
    );
  }

  if (screen === 'lineup') {
    // The full squad, not just whoever's in today's game — someone who sat
    // out this week (or the last one, before this device was reset) still
    // needs to show up here to be checked back in, and mid-game additions
    // that never made it into the saved team shouldn't vanish either.
    const fullSquad = [
      ...new Set([...(store.loadTeam()?.names ?? []), ...game.players.map((p) => p.name)]),
    ];
    return (
      <>
        <LineupScreen
          savedTeam={{ name: teamName, names: fullSquad }}
          onCancel={() => setScreen('settings')}
          onStart={(playingNames, name, fullRoster) => {
            store.saveTeam({ name, names: fullRoster });
            store.clearGame();
            setTeamName(name);
            const settings = game.settings.subsPerRotationAuto
              ? { ...game.settings, subsPerRotation: E.defaultSubsPerRotation(playingNames.length, game.settings) }
              : game.settings;
            setGame(E.createGame(playingNames, settings));
            setScreen('game');
          }}
        />
        {updateBanner}
      </>
    );
  }

  if (screen === 'settings') {
    return (
      <>
        <SettingsScreen
          state={game}
          onChange={(settings) => setGame({ ...game, settings })}
          onPlayers={() => setScreen('players')}
          onDone={() => setScreen('game')}
          onLineup={() => setScreen('lineup')}
          onTransfer={() => { commit(game, nowMs); setScreen('transfer'); }}
        />
        {updateBanner}
      </>
    );
  }

  if (screen === 'players') {
    return (
      <>
        <PlayersScreen
          state={game}
          nowMs={nowMs}
          onAdd={(name, credit) => {
            commit(E.addPlayerMidGame(game, name, credit, nowMs), nowMs);
            setLastActionLabel(`${name} added to the squad`);
          }}
          onDone={() => setScreen('game')}
        />
        {updateBanner}
      </>
    );
  }

  if (screen === 'transfer') {
    return (
      <>
        <TransferScreen state={game} teamName={teamName} onDone={() => setScreen('game')} />
        {updateBanner}
      </>
    );
  }

  /* ---- game screen ----------------------------------------------------- */

  const untilRotation = E.msUntilRotation(game, nowMs);
  const periodLeft = E.msLeftInPeriod(game, nowMs);
  const red = E.inRedWindow(game, nowMs);
  const noMoreSubs = E.rotationsDone(game, nowMs);
  // Everyone held on, or nobody left on the bench — the countdown is moot.
  const canSub = roles.nextOff.length > 0 && roles.nextIn.length > 0;
  const due = untilRotation <= 0 && !noMoreSubs;
  const overPeriod = E.periodOver(game, nowMs);
  const finalPeriod = E.isFinalPeriod(game);

  const subLabel = noMoreSubs
    ? overPeriod
      ? finalPeriod ? 'Game over' : 'Half over'
      : 'No more subs'
    : !canSub
    ? 'No subs available'
    : due
    ? `Sub now (${roles.nextOff.length})`
    : E.formatMs(untilRotation);

  const toggleClock = () => {
    // Nothing left to time — the banner's "Start second half" is the way on.
    if (overPeriod && !game.clock.running) return;
    if (game.clock.running && game.settings.confirmPauseClock) {
      setConfirmPause(true);
      return;
    }
    commit(E.setClockRunning(game, !game.clock.running, nowMs), nowMs);
  };

  const bannerText = swap
    ? swap.direction === 'off'
      ? `Taking ${E.getPlayer(game, swap.fromId).name} off — tap who comes on`
      : `Bringing ${E.getPlayer(game, swap.fromId).name} on — tap who comes off`
    : null;

  return (
    <div className="app">
      <div className="topbar">
        <button onClick={() => setScreen('settings')} aria-label="Settings">
          ⚙
        </button>
        <button className="score" onClick={() => setShowScore(true)}>
          {game.score[0]} – {game.score[1]}
        </button>
        <button
          onClick={() => setConfirmUndo(true)}
          disabled={!E.canUndo(game)}
          style={{ opacity: E.canUndo(game) ? 1 : 0.35 }}
        >
          Undo
        </button>
      </div>

      <div className="periodbar">
        {game.settings.periods === 2 ? `Half ${game.clock.period}/2` : 'Full game'}
        {game.pendingRotation ? ' · subs waiting' : ''}
      </div>

      {bannerText && (
        <div className="banner">
          <span>{bannerText}</span>
          <button onClick={() => setSwap(null)}>Cancel</button>
        </div>
      )}

      {redWarning && (
        <div className="banner warn">
          <span>{due ? 'Scheduled subs are due' : `Scheduled subs in ${E.formatMs(untilRotation)}`}</span>
          <button
            onClick={() => {
              const id = redWarning;
              setRedWarning(null);
              const onField = ['field', 'nextOff'].includes(E.roleOf(game, id, nowMs));
              setSwap({ fromId: id, direction: onField ? 'off' : 'on' });
            }}
          >
            Swap anyway
          </button>
          <button onClick={() => setRedWarning(null)}>Wait</button>
        </div>
      )}

      {overPeriod && (
        <div className="banner warn">
          <span>
            {finalPeriod
              ? `Full time · ${game.score[0]}–${game.score[1]}`
              : `End of the first half`}
          </span>
          {!finalPeriod && (
            // Not commit() — startNextPeriod resets periodElapsedMs to zero and
            // commit would immediately stamp the old elapsed time back over it.
            <button
              onClick={() => {
                setGame(E.startNextPeriod(game, nowMs));
                setLastActionLabel('Second half started');
              }}
            >
              Start second half
            </button>
          )}
        </div>
      )}

      <div className="roster">
        {game.order.map((id) => (
          <PlayerRow
            key={id}
            state={game}
            id={id}
            nowMs={nowMs}
            swap={swap}
            isTarget={Boolean(swap) && targets.includes(id)}
            leastTime={id === leastTimeId}
            onTap={(pid) => (swap ? targets.includes(pid) && completeSwap(pid) : beginSwap(pid))}
            onHold={(pid) => !swap && setSheet({ kind: 'player', id: pid })}
          />
        ))}
      </div>

      <div className="controls">
        <button
          className={`clockbtn clockbtn--rotation${red ? ' clockbtn--red' : ''}${
            due ? ' clockbtn--due' : ''
          }${noMoreSubs || !canSub ? ' clockbtn--spent' : ''}`}
          disabled={noMoreSubs || !canSub}
          onClick={() => setGame(E.proposeRotation(E.prepareRotation(game, nowMs), nowMs))}
        >
          {subLabel}
        </button>

        <button
          className="swapbtn"
          disabled={!canSub}
          onClick={() => setGame(E.proposeRotation(E.prepareRotation(game, nowMs), nowMs))}
          aria-label="Substitute now"
        >
          ⇄
        </button>

        <button
          className={`clockbtn${overPeriod ? ' clockbtn--spent' : ''}`}
          onClick={toggleClock}
          disabled={overPeriod && !game.clock.running}
        >
          {E.formatMs(periodLeft)} {overPeriod ? '' : game.clock.running ? '⏸' : '▶'}
        </button>
      </div>

      {game.pendingRotation && !blocked && (
        <RotationDialog
          state={game}
          onConfirm={() => {
            const { off, on } = game.pendingRotation;
            setLastActionLabel(
              `${off.map((id) => E.getPlayer(game, id).name).join(', ')} off, ${on
                .map((id) => E.getPlayer(game, id).name)
                .join(', ')} on`
            );
            commit(E.applyRotation(game, nowMs), nowMs);
          }}
          onPostpone={() => commit(E.postponeRotation(game), nowMs)}
        />
      )}

      {sheet?.kind === 'player' && (
        <PlayerSheet
          state={game}
          id={sheet.id}
          nowMs={nowMs}
          onClose={() => setSheet(null)}
          onAction={handleSheetAction}
        />
      )}

      {sheet?.kind === 'keeper' && (
        <KeeperSheet
          state={game}
          nowMs={nowMs}
          onClose={() => setSheet(null)}
          onChoose={(source, id) => {
            setSheet(null);
            if (source === 'bench') {
              const label = `${E.getPlayer(game, id).name} in goal`;
              commit(E.earlySwap(game, roles.keeperId, id, nowMs), nowMs);
              setLastActionLabel(label);
              flash(`${E.getPlayer(game, id).name} is in goal`, [
                ['Undo', () => setGame((g) => E.undo(g, nowMs))],
              ]);
            } else {
              const replacement = roles.bench[0] ?? null;
              const label = replacement
                ? `${E.getPlayer(game, id).name} in goal, ${E.getPlayer(game, replacement).name} on`
                : `${E.getPlayer(game, id).name} in goal`;
              commit(E.keeperHandover(game, roles.keeperId, id, replacement, nowMs), nowMs);
              setLastActionLabel(label);
              flash(label, [['Undo', () => setGame((g) => E.undo(g, nowMs))]]);
            }
          }}
        />
      )}

      {sheet?.kind === 'reason' && (
        <ReasonSheet
          name={E.getPlayer(game, sheet.id).name}
          onClose={() => setSheet(null)}
          onChoose={(reason) => {
            const id = sheet.id;
            setSheet(null);
            const name = E.getPlayer(game, id).name;
            const onField = roles.onFieldIds.includes(id);
            const replacement = onField ? roles.bench[0] ?? null : null;
            const label = onField && !replacement ? `${name} off — playing short` : `${name} is out`;
            commit(E.markUnavailable(game, id, reason, nowMs, replacement), nowMs);
            setLastActionLabel(label);
            flash(label, [['Undo', () => setGame((g) => E.undo(g, nowMs))]]);
          }}
        />
      )}

      {showScore && (
        <ScoreDialog
          score={game.score}
          scorers={game.scorers ?? []}
          onClose={() => setShowScore(false)}
          onGoal={() => setSheet({ kind: 'goal' })}
          onUndoGoal={() => setGame(E.removeLastGoal(game))}
          onChange={(index, delta) => {
            const next = [...game.score];
            next[index] = Math.max(0, next[index] + delta);
            setGame(E.setScore(game, next[0], next[1]));
          }}
        />
      )}

      {sheet?.kind === 'goal' && (
        <GoalScorerSheet
          state={game}
          nowMs={nowMs}
          onClose={() => setSheet(null)}
          onChoose={(id) => {
            setSheet(null);
            setGame(E.addGoal(game, id, nowMs));
          }}
        />
      )}

      {confirmPause && (
        <ConfirmDialog
          title="Pause the game clock?"
          message="Playing time stops for everyone on the field. The referee won't be stopping theirs, so only pause for a real stoppage."
          confirmLabel="Pause"
          onClose={() => setConfirmPause(false)}
          onConfirm={() => {
            commit(E.setClockRunning(game, false, nowMs), nowMs);
            setConfirmPause(false);
          }}
        />
      )}

      {confirmUndo && (
        <ConfirmDialog
          title="Undo last action?"
          message={lastActionLabel ? `This undoes: ${lastActionLabel}.` : undefined}
          confirmLabel="Undo"
          onClose={() => setConfirmUndo(false)}
          onConfirm={() => {
            setGame(E.undo(game, nowMs));
            setConfirmUndo(false);
          }}
        />
      )}

      {toast ? <Toast message={toast.message} actions={toast.actions} /> : updateBanner}
    </div>
  );
}

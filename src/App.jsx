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
  PlayersScreen,
  SettingsScreen,
  SetupScreen,
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
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const { needRefresh, applyUpdate } = useServiceWorkerUpdate();
  const updateBanner = needRefresh && !updateDismissed ? (
    <Toast
      message="A new version is ready — updating reloads the app, so do it between games."
      actions={[
        ['Update', applyUpdate],
        ['Later', () => setUpdateDismissed(true)],
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
  const nowMs = useGameClock(clockRunning, game?.clock.periodElapsedMs ?? 0);
  useWakeLock(Boolean(game?.clock.running));

  const commit = useCallback((next, ms) => {
    setGame({ ...next, clock: { ...next.clock, periodElapsedMs: ms } });
  }, []);

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
    return swap.direction === 'off'
      ? roles.bench
      : roles.onFieldIds.filter((id) => id !== roles.keeperId || game.settings.keeperEnabled);
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
    // §4.4 — intervene before the coach commits, not after.
    if (E.inRedWindow(game, nowMs)) {
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
      setLastActionLabel(`${name} moved in the queue`);
    } else if (action === 'unavailable') {
      setSheet({ kind: 'reason', id });
    }
  };

  /* ---- screens --------------------------------------------------------- */

  if (!game) {
    return (
      <>
        <SetupScreen
          savedTeam={store.loadTeam()}
          error={setupError}
          onRestore={() => setSetupError('Open the link your coach sent and it will load here.')}
          onStart={(names, name) => {
            store.saveTeam({ name, names });
            setTeamName(name);
            const subsPerRotation = E.defaultSubsPerRotation(names.length, E.DEFAULT_SETTINGS);
            setGame(E.createGame(names, { subsPerRotation }));
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
          onNewGame={() => {
            store.clearGame();
            const names = game.players.map((p) => p.name);
            const settings = game.settings.subsPerRotationAuto
              ? { ...game.settings, subsPerRotation: E.defaultSubsPerRotation(names.length, game.settings) }
              : game.settings;
            setGame(E.createGame(names, settings));
            setScreen('game');
          }}
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
      ? finalPeriod ? 'Game over' : 'Period over'
      : 'No more subs'
    : !canSub
    ? 'No subs available'
    : due
    ? `Sub now (${roles.nextOff.length})`
    : E.formatMs(untilRotation);

  const toggleClock = () => {
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
        <button onClick={() => { commit(game, nowMs); setScreen('transfer'); }} aria-label="Hand over to another phone">
          ⇪
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
        Period {game.clock.period}/{game.settings.periods}
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
          <span>Scheduled subs in {E.formatMs(untilRotation)}</span>
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
              : `End of period ${game.clock.period}`}
          </span>
          {!finalPeriod && (
            // Not commit() — startNextPeriod resets periodElapsedMs to zero and
            // commit would immediately stamp the old elapsed time back over it.
            <button
              onClick={() => {
                setGame(E.startNextPeriod(game, nowMs));
                setLastActionLabel(`Period ${game.clock.period + 1} started`);
              }}
            >
              Start period {game.clock.period + 1}
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

        <button className="clockbtn" onClick={toggleClock}>
          {E.formatMs(periodLeft)} {game.clock.running ? '⏸' : '▶'}
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

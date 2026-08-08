import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as E from './engine/rotation.js';
import { decodeGame, readIncomingLink, TransferError } from './engine/transfer.js';
import * as store from './engine/persistence.js';
import { useGameClock, useWakeLock } from './hooks/useGameClock.js';
import PlayerRow from './components/PlayerRow.jsx';
import {
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

  const modalOpen = Boolean(game?.pendingRotation || sheet || swap);
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
  const blocked = Boolean(swap || sheet || showScore);

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

  const leastTimeId = useMemo(() => {
    if (!targets.length) return null;
    return [...targets].sort((a, b) => E.playedMs(game, a, nowMs) - E.playedMs(game, b, nowMs))[0];
  }, [targets, game, nowMs]);

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
    navigator.vibrate?.(18);

    const actions = [['Undo', () => setGame((g) => E.undo(g))]];
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
      commit(E.returnToRotation(game, id, nowMs), nowMs);
      flash(`${E.getPlayer(game, id).name} is back in the rotation`);
    } else if (action === 'keeper') {
      commit(E.swapKeeperWithField(game, id, nowMs), nowMs);
      flash(`${E.getPlayer(game, id).name} is in goal`);
    } else if (action === 'moveTo') {
      const from = game.order.indexOf(id);
      const onField = ['field', 'nextOff'].includes(E.roleOf(game, id, nowMs));
      const to = onField ? (game.settings.keeperEnabled ? 1 : 0) : roles.bench.length
        ? game.order.indexOf(roles.bench[0])
        : from;
      commit(E.reorder(game, from, to, nowMs), nowMs);
    } else if (action === 'unavailable') {
      setSheet({ kind: 'reason', id });
    }
  };

  /* ---- screens --------------------------------------------------------- */

  if (!game) {
    return (
      <SetupScreen
        savedTeam={store.loadTeam()}
        error={setupError}
        onRestore={() => setSetupError('Open the link your coach sent and it will load here.')}
        onStart={(names, name) => {
          store.saveTeam({ name, names });
          setTeamName(name);
          setGame(E.createGame(names));
        }}
      />
    );
  }

  if (screen === 'settings') {
    return (
      <SettingsScreen
        state={game}
        onChange={(settings) => setGame({ ...game, settings })}
        onPlayers={() => setScreen('players')}
        onDone={() => setScreen('game')}
        onNewGame={() => {
          store.clearGame();
          setGame(E.createGame(game.players.map((p) => p.name), game.settings));
          setScreen('game');
        }}
      />
    );
  }

  if (screen === 'players') {
    return (
      <PlayersScreen
        state={game}
        nowMs={nowMs}
        onAdd={(name, credit) => commit(E.addPlayerMidGame(game, name, credit, nowMs), nowMs)}
        onDone={() => setScreen('game')}
      />
    );
  }

  if (screen === 'transfer') {
    return <TransferScreen state={game} teamName={teamName} onDone={() => setScreen('game')} />;
  }

  /* ---- game screen ----------------------------------------------------- */

  const untilRotation = E.msUntilRotation(game, nowMs);
  const periodLeft = E.periodLengthMs(game) - nowMs;
  const red = E.inRedWindow(game, nowMs);
  const due = untilRotation <= 0;

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
          onClick={() => setGame(E.undo(game))}
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
          }`}
          onClick={() => setGame(E.proposeRotation(E.prepareRotation(game, nowMs), nowMs))}
        >
          {due ? `Sub now (${game.settings.subsPerRotation})` : E.formatMs(untilRotation)}
        </button>

        <button
          className="swapbtn"
          onClick={() => setGame(E.proposeRotation(E.prepareRotation(game, nowMs), nowMs))}
          aria-label="Substitute now"
        >
          ⇄
        </button>

        <button
          className="clockbtn"
          onClick={() => commit(E.setClockRunning(game, !game.clock.running, nowMs), nowMs)}
        >
          {E.formatMs(periodLeft)} {game.clock.running ? '⏸' : '▶'}
        </button>
      </div>

      {game.pendingRotation && !blocked && (
        <RotationDialog
          state={game}
          onConfirm={() => commit(E.applyRotation(game, nowMs), nowMs)}
          onPostpone={() => commit(E.postponeRotation(game, nowMs), nowMs)}
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
              commit(E.earlySwap(game, roles.keeperId, id, nowMs), nowMs);
              flash(`${E.getPlayer(game, id).name} is in goal`, [
                ['Undo', () => setGame((g) => E.undo(g))],
              ]);
            } else {
              const replacement = roles.bench[0] ?? null;
              commit(E.keeperHandover(game, roles.keeperId, id, replacement, nowMs), nowMs);
              flash(
                replacement
                  ? `${E.getPlayer(game, id).name} in goal, ${
                      E.getPlayer(game, replacement).name
                    } on`
                  : `${E.getPlayer(game, id).name} is in goal`,
                [['Undo', () => setGame((g) => E.undo(g))]]
              );
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
            const onField = roles.onFieldIds.includes(id);
            const replacement = onField ? roles.bench[0] ?? null : null;
            commit(E.markUnavailable(game, id, reason, nowMs, replacement), nowMs);
            flash(
              onField && !replacement
                ? `${E.getPlayer(game, id).name} off — playing short`
                : `${E.getPlayer(game, id).name} is out`,
              [['Undo', () => setGame((g) => E.undo(g))]]
            );
          }}
        />
      )}

      {showScore && (
        <ScoreDialog
          score={game.score}
          onClose={() => setShowScore(false)}
          onChange={(index, delta) => {
            const next = [...game.score];
            next[index] = Math.max(0, next[index] + delta);
            setGame(E.setScore(game, next[0], next[1]));
          }}
        />
      )}

      {toast && <Toast message={toast.message} actions={toast.actions} />}
    </div>
  );
}

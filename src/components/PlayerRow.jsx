import { useRef } from 'react';
import * as E from '../engine/rotation.js';

const LABEL = {
  keeper: 'Keeper',
  nextOff: 'Next off',
  field: 'On field',
  nextIn: 'Next in',
  bench: 'Substitute',
  unavailable: 'Unavailable',
};

export default function PlayerRow({
  state,
  id,
  nowMs,
  swap, // { fromId, direction } | null
  isTarget,
  leastTime,
  onTap,
  onHold,
}) {
  const player = E.getPlayer(state, id);
  const role = E.roleOf(state, id, nowMs);
  const onField = role === 'keeper' || role === 'field' || role === 'nextOff';
  const selected = swap?.fromId === id;
  const dim = swap && !selected && !isTarget;

  const held = useRef(false);
  const timer = useRef(null);

  const startHold = () => {
    held.current = false;
    timer.current = setTimeout(() => {
      held.current = true;
      navigator.vibrate?.(12);
      onHold?.(id);
    }, 480);
  };
  const endHold = () => clearTimeout(timer.current);

  const classes = [
    'row',
    `row--${role}`,
    onField ? 'row--onfield' : 'row--offfield',
    selected && 'row--selected',
    isTarget && 'row--target',
    dim && 'row--dim',
  ]
    .filter(Boolean)
    .join(' ');

  const played = E.playedMs(state, id, nowMs);
  const deviation = E.fairnessDeviationMs(state, id, nowMs);

  const label = selected
    ? swap.direction === 'off'
      ? 'Coming off'
      : 'Going on'
    : player.heldOn
    ? 'Staying on'
    : LABEL[role];

  return (
    <button
      type="button"
      className={classes}
      disabled={dim}
      onPointerDown={startHold}
      onPointerUp={endHold}
      onPointerLeave={endHold}
      onClick={() => {
        endHold();
        if (!held.current) onTap?.(id);
      }}
      aria-label={`${player.name}, ${label}, ${E.formatMs(played)} played`}
    >
      <span className="row__main">
        <span className="row__name">{player.name}</span>
        <span className="row__role">({label})</span>
        {isTarget && leastTime && <span className="badge">Least time</span>}
        {player.unavailable && (
          <span className="row__role">{player.unavailable.reason}</span>
        )}
      </span>

      {isTarget ? (
        <span className="row__cta">{swap.direction === 'off' ? 'Bring on' : 'Take off'}</span>
      ) : (
        role === 'nextOff' && <span className="row__arrow arrow--off">←</span>
      )}
      {!isTarget && role === 'nextIn' && <span className="row__arrow arrow--on">→</span>}

      <span className="row__times">
        <span className="row__time">{E.formatMs(played)}</span>
        {state.settings.showFairnessDeviation && !player.unavailable && (
          <span className="row__dev">{E.formatSigned(deviation)}</span>
        )}
      </span>
    </button>
  );
}

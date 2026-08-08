import * as E from '../engine/rotation.js';

const names = (state, ids) =>
  ids
    .map((id) => E.getPlayer(state, id)?.name)
    .filter(Boolean)
    .reduce((acc, n, i, arr) => (i === 0 ? n : i === arr.length - 1 ? `${acc} and ${n}` : `${acc}, ${n}`), '');

export function Scrim({ children, center, onClose }) {
  return (
    <div
      className={center ? 'scrim scrim--center' : 'scrim'}
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
    >
      {children}
    </div>
  );
}

/** The dialog that already exists in the prototype (§A6, §A6b). */
export function RotationDialog({ state, onConfirm, onPostpone }) {
  const { off, on } = state.pendingRotation;
  return (
    <Scrim center>
      <div className="dialog" role="dialog" aria-modal="true">
        <h2>Confirm substitution</h2>
        <div className="subgroup subgroup--in">
          <div className="subgroup__label">In →</div>
          <div className="subgroup__names">{names(state, on)}</div>
        </div>
        <div className="subgroup subgroup--out">
          <div className="subgroup__label">← Out</div>
          <div className="subgroup__names">{names(state, off)}</div>
        </div>
        <div className="dialog__actions">
          <button className="btn" onClick={onPostpone}>
            Not yet
          </button>
          <button className="btn btn--primary" onClick={onConfirm}>
            Make the subs
          </button>
        </div>
      </div>
    </Scrim>
  );
}

/** Long-press sheet: the actions that aren't a swap (§3.2). */
export function PlayerSheet({ state, id, nowMs, onClose, onAction }) {
  const player = E.getPlayer(state, id);
  const role = E.roleOf(state, id, nowMs);
  const onField = ['keeper', 'field', 'nextOff'].includes(role);

  const items = [];
  if (player.unavailable) {
    items.push(['return', 'Return to the rotation']);
  } else {
    if (role !== 'keeper' && state.settings.keeperEnabled) {
      items.push(['keeper', onField ? 'Put in goal' : 'Bring on in goal']);
    }
    items.push([
      'moveTo',
      onField ? 'Move to the front of the queue' : 'Move to the front of the bench',
    ]);
    items.push(['unavailable', 'Mark unavailable']);
  }

  return (
    <Scrim onClose={onClose}>
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet__head">
          <div className="sheet__title">{player.name}</div>
          <div className="sheet__sub">
            {E.formatMs(E.playedMs(state, id, nowMs))} played
            {onField && ` · ${E.formatMs(E.stintMs(state, id, nowMs))} this stint`}
          </div>
        </div>
        {items.map(([action, label]) => (
          <button
            key={action}
            className={`sheet__item${action === 'unavailable' ? ' sheet__item--danger' : ''}`}
            onClick={() => onAction(action, id)}
          >
            {label}
          </button>
        ))}
      </div>
    </Scrim>
  );
}

/** §5.1 — keeper off is a three-way move, so it gets its own step. */
export function KeeperSheet({ state, nowMs, onClose, onChoose }) {
  const r = E.roles(state, nowMs);
  return (
    <Scrim onClose={onClose}>
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet__head">
          <div className="sheet__title">Who goes in goal?</div>
          <div className="sheet__sub">
            {E.getPlayer(state, r.keeperId)?.name} comes off
          </div>
        </div>
        {r.bench.slice(0, 4).map((id) => (
          <button key={id} className="sheet__item" onClick={() => onChoose('bench', id)}>
            <span style={{ flex: 1 }}>{E.getPlayer(state, id).name}</span>
            <span className="row__role">off the bench</span>
          </button>
        ))}
        {r.field.map((id) => (
          <button key={id} className="sheet__item" onClick={() => onChoose('field', id)}>
            <span style={{ flex: 1 }}>{E.getPlayer(state, id).name}</span>
            <span className="row__role">already on the field</span>
          </button>
        ))}
      </div>
    </Scrim>
  );
}

export function ReasonSheet({ name, onClose, onChoose }) {
  return (
    <Scrim onClose={onClose}>
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet__head">
          <div className="sheet__title">Why is {name} unavailable?</div>
          <div className="sheet__sub">They stop accruing time either way.</div>
        </div>
        {[
          ['injured', 'Injured'],
          ['left', 'Left early'],
          ['other', 'Something else'],
        ].map(([value, label]) => (
          <button key={value} className="sheet__item" onClick={() => onChoose(value)}>
            {label}
          </button>
        ))}
      </div>
    </Scrim>
  );
}

export function ScoreDialog({ score, onChange, onClose }) {
  const Stepper = ({ label, value, index }) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 15, marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22 }}>
        <button
          className="btn"
          style={{ width: 60, flex: 'none', borderRadius: 999 }}
          onClick={() => onChange(index, -1)}
          aria-label={`${label} down`}
        >
          −
        </button>
        <span style={{ fontFamily: 'var(--num)', fontSize: 32, fontWeight: 700, minWidth: 34 }}>
          {value}
        </span>
        <button
          className="btn"
          style={{ width: 60, flex: 'none', borderRadius: 999 }}
          onClick={() => onChange(index, 1)}
          aria-label={`${label} up`}
        >
          +
        </button>
      </div>
    </div>
  );

  return (
    <Scrim center onClose={onClose}>
      <div className="dialog" role="dialog" aria-modal="true">
        <h2>Score</h2>
        <Stepper label="Us" value={score[0]} index={0} />
        <Stepper label="Them" value={score[1]} index={1} />
        <button className="btn btn--primary btn--full" onClick={onClose}>
          Done
        </button>
      </div>
    </Scrim>
  );
}

export function Toast({ message, actions }) {
  return (
    <div className="toast" role="status">
      <span className="toast__msg">{message}</span>
      {actions.map(([label, fn]) => (
        <button key={label} onClick={fn}>
          {label}
        </button>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import * as E from '../engine/rotation.js';
import { buildLink } from '../engine/transfer.js';
import { isIOS, isStandalone } from '../engine/persistence.js';

/* ---- setup -------------------------------------------------------------- */

// Seeded so the squad doesn't need retyping every time the app is reset for
// testing. Also just this team's actual roster.
const DEFAULT_SQUAD = [
  'Dylan', 'Kit', 'Pippa', 'Chanel', 'Dottie', 'Val', 'Leni', 'Harriet', 'Kora', 'Claudia', 'Amelia',
];

/** Fisher–Yates, in place — for shuffling a fresh starting lineup. */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * The saved squad is the whole club roster and outlives any one game — not
 * everyone on it shows up every week. This screen splits the two: names are
 * added/edited/removed here permanently, but who's actually playing today is
 * a separate per-name checkbox that defaults to everyone, so a coach missing
 * two of eleven just unchecks them rather than deleting them from the squad.
 *
 * Doubles as both the very first "who's on the team" setup and, via
 * `onCancel`, the "start a new game" flow reached from Settings mid-season —
 * same screen, same roster, just with a way back out when there's a live
 * game underneath it.
 */
export function LineupScreen({ savedTeam, onStart, onRestore, onCancel, error }) {
  const [names, setNames] = useState(savedTeam?.names ?? DEFAULT_SQUAD);
  const [playing, setPlaying] = useState(() => names.map(() => true));
  const [teamName, setTeamName] = useState(savedTeam?.name ?? '');
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [randomizeLineup, setRandomizeLineup] = useState(false);

  const add = () => {
    const clean = draft.trim();
    if (!clean) return;
    setNames((prev) => [...prev, clean]);
    setPlaying((prev) => [...prev, true]);
    setDraft('');
  };

  const remove = (i) => {
    setNames((prev) => prev.filter((_, j) => j !== i));
    setPlaying((prev) => prev.filter((_, j) => j !== i));
  };

  const startEdit = (i) => {
    setEditingIndex(i);
    setEditDraft(names[i]);
  };

  const saveEdit = () => {
    const clean = editDraft.trim();
    if (clean) setNames((prev) => prev.map((n, j) => (j === editingIndex ? clean : n)));
    setEditingIndex(null);
  };

  const playingCount = playing.filter(Boolean).length;

  const start = () => {
    const playingNames = names.filter((_, i) => playing[i]);
    onStart(randomizeLineup ? shuffle([...playingNames]) : playingNames, teamName, names);
  };

  return (
    <div className="app">
      <div className="screen">
        <h1>Team lineup</h1>
        <p className="lede">
          {onCancel
            ? "Everyone's checked by default — untick anyone who isn't here today."
            : "Add everyone in the squad, then untick anyone who isn't playing today."}
        </p>

        {error && <div className="note note--warn">{error}</div>}

        <div className="field">
          <input
            type="text"
            value={teamName}
            placeholder="Team name (optional)"
            onChange={(e) => setTeamName(e.target.value)}
          />
        </div>

        <div className="field" style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={draft}
            placeholder="Player name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn" style={{ flex: 'none', width: 84 }} onClick={add}>
            Add
          </button>
        </div>

        {names.length === 0 ? (
          <p className="lede">No players yet. Add the first one above.</p>
        ) : (
          names.map((n, i) =>
            editingIndex === i ? (
              <div className="playerline" key={i}>
                <input
                  type="text"
                  className="playerline__edit"
                  value={editDraft}
                  autoFocus
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit();
                    if (e.key === 'Escape') setEditingIndex(null);
                  }}
                  onBlur={saveEdit}
                />
              </div>
            ) : (
              <div className={`playerline${playing[i] ? '' : ' playerline--out'}`} key={i}>
                <button
                  type="button"
                  className="playerline__check"
                  data-checked={playing[i]}
                  aria-label={playing[i] ? `${n} is playing today` : `${n} is not playing today`}
                  onClick={() => setPlaying((prev) => prev.map((p, j) => (j === i ? !p : p)))}
                >
                  {playing[i] ? '✓' : ''}
                </button>
                <button className="playerline__name" onClick={() => startEdit(i)}>
                  {n}
                </button>
                <button className="playerline__edit-btn" onClick={() => startEdit(i)}>
                  Edit
                </button>
                <button className="playerline__remove" onClick={() => remove(i)}>
                  Remove
                </button>
              </div>
            )
          )
        )}

        {isIOS() && !isStandalone() && (
          <div className="note note--advice">
            <strong>Add this to your home screen.</strong> Tap Share, then Add to Home Screen.
            Safari clears saved data after a week of not opening a site, and this one only gets
            used on Saturdays — installed apps aren't affected.
          </div>
        )}

        {!onCancel && (
          <div className="note">
            Got a link from your coach? <button onClick={onRestore}>Open it here</button> to load
            the squad.
          </div>
        )}

        <Toggle
          label="Randomise the lineup"
          on={randomizeLineup}
          onChange={setRandomizeLineup}
        />
        <div className="note">
          Shuffles who starts as keeper, on the field and on the bench, instead of keeping the
          order above.
        </div>

        {onCancel && (
          <div className="note note--warn">
            Starting resets the clock and every player's time — today's game will begin from
            scratch.
          </div>
        )}
      </div>

      <div className="footer">
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn--primary" disabled={playingCount < 2} onClick={start}>
          {playingCount < 2 ? 'Pick at least two players' : `Start a new game (${playingCount})`}
        </button>
      </div>
    </div>
  );
}

/* ---- settings ----------------------------------------------------------- */

function Slider({ label, value, min, max, step = 1, format, onChange }) {
  return (
    <div className="field">
      <div className="field__label">
        <span>{label}</span>
        <span className="field__value">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Toggle({ label, on, onChange }) {
  return (
    <button className="toggle" style={{ width: '100%' }} onClick={() => onChange(!on)}>
      <span>{label}</span>
      <span className="switch" data-on={on} />
    </button>
  );
}

export function SettingsScreen({ state, onChange, onDone, onPlayers, onLineup, onTransfer }) {
  const s = state.settings;
  const set = (patch) => onChange({ ...s, ...patch });
  // fieldPlayers/keeperEnabled change the bench size, so re-derive
  // subsPerRotation from it — but only while the user hasn't taken the wheel.
  const setSquadShape = (patch) => {
    const next = { ...s, ...patch };
    if (s.subsPerRotationAuto) {
      next.subsPerRotation = E.defaultSubsPerRotation(state.players.length, next);
    }
    onChange(next);
  };
  const advice = E.fairnessAdvice(state);

  return (
    <div className="app">
      <div className="screen">
        <h1>Game settings</h1>

        <Slider
          label="Players on the field"
          value={s.fieldPlayers}
          min={3}
          max={10}
          onChange={(v) => setSquadShape({ fieldPlayers: v })}
          format={(v) => (s.keeperEnabled ? `${v} + keeper` : `${v}`)}
        />
        <Toggle
          label="Play with a keeper"
          on={s.keeperEnabled}
          onChange={(v) => setSquadShape({ keeperEnabled: v })}
        />
        <Slider
          label="Players swapped each time"
          value={s.subsPerRotation}
          min={1}
          max={Math.max(1, s.fieldPlayers)}
          onChange={(v) => set({ subsPerRotation: v, subsPerRotationAuto: false })}
        />
        <Slider
          label="Minutes between subs"
          value={s.rotationSeconds / 60}
          min={1}
          max={15}
          step={0.5}
          onChange={(v) => set({ rotationSeconds: Math.round(v * 60) })}
          format={(v) => E.formatMs(v * 60000)}
        />
        <Slider
          label="Stop subbing near the end"
          value={s.minRotationRemainderSeconds / 60}
          min={0}
          max={10}
          step={1}
          onChange={(v) => set({ minRotationRemainderSeconds: Math.round(v * 60) })}
          format={(v) => (v === 0 ? 'Off' : `${v} min left`)}
        />
        <div className="note">
          Below this the half is treated as done and no more subs are offered. Bringing a player
          on for the last ninety seconds costs the one coming off more than it gives them.
        </div>
        <Slider
          label="Total game time"
          value={s.totalGameMinutes}
          min={20}
          max={90}
          step={5}
          onChange={(v) => set({ totalGameMinutes: v })}
          format={(v) => `${v} min`}
        />
        <Toggle
          label="Play in two halves"
          on={s.periods === 2}
          onChange={(v) => set({ periods: v ? 2 : 1 })}
        />
        <div className="note">
          {s.periods === 2
            ? `Two ${E.formatMs((s.totalGameMinutes * 60000) / 2)} halves, with a break at half time to re-seed the queue.`
            : `One continuous ${E.formatMs(s.totalGameMinutes * 60000)} period — no half-time break.`}
        </div>

        {advice && !advice.evenlyDivides && (
          <div className="note note--advice">
            These settings end mid-rotation.
            {/* A suggestion under four minutes is no help — it trades an uneven
                finish for a sub every other attack. Better to say nothing. */}
            {advice.suggestedRotationSeconds >= 240 && (
              <>
                {' '}
                <button
                  className="note__plain"
                  onClick={() => set({ rotationSeconds: advice.suggestedRotationSeconds })}
                >
                  Use {E.formatMs(advice.suggestedRotationSeconds * 1000)} instead
                </button>{' '}
                and everyone gets {advice.everyPlayerMinutes} minutes.
              </>
            )}
          </div>
        )}
        {advice?.evenlyDivides && (
          <div className="note">
            Everyone gets {advice.everyPlayerMinutes} minutes, give or take any early swaps.
          </div>
        )}

        <h1 style={{ fontSize: 19, marginTop: 28 }}>Fairness</h1>
        <Slider
          label="Rest before going back on"
          value={s.minBenchRestSeconds}
          min={0}
          max={180}
          step={15}
          onChange={(v) => set({ minBenchRestSeconds: v })}
          format={(v) => (v === 0 ? 'Off' : `${v}s`)}
        />
        <div className="note">
          Stops a player who came off early being sent straight back on at the next scheduled
          sub.
        </div>
        <Toggle
          label="Keeper minutes count as playing time"
          on={s.keeperTimeCounts}
          onChange={(v) => set({ keeperTimeCounts: v })}
        />
        <Toggle
          label="Least played start each half"
          on={s.balanceAtPeriodStart}
          onChange={(v) => set({ balanceAtPeriodStart: v })}
        />
        <div className="note">
          A half that stops mid-rotation leaves some players minutes ahead. This re-seeds the
          queue at the break so the second half corrects it instead of compounding it.
        </div>
        <Toggle
          label="Pause the game clock during dialogs"
          on={s.pauseGameClockOnDialog}
          onChange={(v) => set({ pauseGameClockOnDialog: v })}
        />
        <div className="note">
          Off by default so the clock matches the referee's. Turn it on if you're the one keeping
          official time.
        </div>
        <Toggle
          label="Ask before pausing the clock"
          on={s.confirmPauseClock}
          onChange={(v) => set({ confirmPauseClock: v })}
        />

        <button className="btn btn--full" style={{ marginTop: 20 }} onClick={onTransfer}>
          Hand over to another phone
        </button>
        <button
          className="btn btn--full"
          style={{ marginTop: 10, color: 'var(--off)', borderColor: 'var(--off)' }}
          onClick={onLineup}
        >
          Team lineup — start a new game
        </button>
      </div>

      <div className="footer">
        <button className="btn" onClick={onPlayers}>
          Players ({state.players.length})
        </button>
        <button className="btn btn--primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/* ---- players ------------------------------------------------------------ */

export function PlayersScreen({ state, nowMs, onAdd, onDone }) {
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(null);
  const started = state.clock.periodElapsedMs > 0 || state.clock.period > 1;

  const submit = () => {
    const clean = draft.trim();
    if (!clean) return;
    if (started) setPending(clean);
    else {
      onAdd(clean, 'zero');
      setDraft('');
    }
  };

  return (
    <div className="app">
      <div className="screen">
        <h1>Players ({state.players.length})</h1>

        <div className="field" style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={draft}
            placeholder="New player name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <button className="btn" style={{ flex: 'none', width: 84 }} onClick={submit}>
            Add
          </button>
        </div>

        {pending && (
          <div className="note note--advice">
            <strong>When did {pending} arrive?</strong> Starting at zero puts them straight to the
            front of the bench for the next few subs.
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                className="btn"
                onClick={() => {
                  onAdd(pending, 'zero');
                  setPending(null);
                  setDraft('');
                }}
              >
                Just now
              </button>
              <button
                className="btn"
                onClick={() => {
                  onAdd(pending, 'average');
                  setPending(null);
                  setDraft('');
                }}
              >
                Match the squad
              </button>
            </div>
          </div>
        )}

        {state.order.map((id) => (
          <div className="playerline" key={id}>
            <span className="playerline__name">{E.getPlayer(state, id).name}</span>
            <span
              style={{
                fontFamily: 'var(--num)',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--ink-soft)',
              }}
            >
              {E.formatMs(E.playedMs(state, id, nowMs))}
            </span>
          </div>
        ))}
      </div>

      <div className="footer">
        <button className="btn btn--primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/* ---- transfer ----------------------------------------------------------- */

export function TransferScreen({ state, teamName, onDone }) {
  const [kind, setKind] = useState('live');
  const [copied, setCopied] = useState(false);
  const canvas = useRef(null);
  const link = buildLink(state, kind, teamName);

  useEffect(() => {
    if (!canvas.current) return;
    // High error correction: this gets scanned off a phone screen in sunlight.
    QRCode.toCanvas(canvas.current, link, {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 600,
    })
      .then(() => {
        // The library stamps inline width/height on the canvas, which outranks
        // the stylesheet: max-width pulled the width down to 300 while the
        // height stayed at 600 and the code rendered as a rectangle. Dropping
        // the inline pair hands sizing back to CSS, which keeps it square.
        if (!canvas.current) return;
        canvas.current.style.width = '';
        canvas.current.style.height = '';
      })
      .catch(() => {});
  }, [link]);

  return (
    <div className="app">
      <div className="screen">
        <h1>Hand over the game</h1>
        <p className="lede">
          Point the other phone's camera at this code. Everything transfers — squad, settings, and
          every minute played so far. No signal needed.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          {[
            ['setup', 'Squad only'],
            ['live', 'The game as it stands'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={`btn${kind === value ? ' btn--primary' : ''}`}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <canvas ref={canvas} className="qr" />

        <button
          className="btn btn--full"
          onClick={async () => {
            try {
              if (navigator.share) await navigator.share({ url: link, title: 'Soccer subs' });
              else {
                await navigator.clipboard.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 2500);
              }
            } catch {
              /* the coach cancelled the share sheet */
            }
          }}
        >
          {copied ? 'Link copied' : 'Send the link instead'}
        </button>

        <div className="note">
          Keep a squad link in your team chat. If this phone ever loses its saved data, opening
          that link puts everything back.
        </div>
      </div>

      <div className="footer">
        <button className="btn btn--primary" onClick={onDone}>
          Back to the game
        </button>
      </div>
    </div>
  );
}

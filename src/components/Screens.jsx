import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import * as E from '../engine/rotation.js';
import { buildLink } from '../engine/transfer.js';
import { isIOS, isStandalone } from '../engine/persistence.js';

/* ---- setup -------------------------------------------------------------- */

export function SetupScreen({ savedTeam, onStart, onRestore, error }) {
  const [names, setNames] = useState(savedTeam?.names ?? []);
  const [teamName, setTeamName] = useState(savedTeam?.name ?? '');
  const [draft, setDraft] = useState('');

  const add = () => {
    const clean = draft.trim();
    if (!clean) return;
    setNames([...names, clean]);
    setDraft('');
  };

  return (
    <div className="app">
      <div className="screen">
        <h1>Who's playing?</h1>
        <p className="lede">
          Add everyone in the squad. The order doesn't matter — you can shuffle the queue once
          the game starts.
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
          names.map((n, i) => (
            <div className="playerline" key={`${n}-${i}`}>
              <span className="playerline__name">{n}</span>
              <button onClick={() => setNames(names.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))
        )}

        {isIOS() && !isStandalone() && (
          <div className="note note--advice">
            <strong>Add this to your home screen.</strong> Tap Share, then Add to Home Screen.
            Safari clears saved data after a week of not opening a site, and this one only gets
            used on Saturdays — installed apps aren't affected.
          </div>
        )}

        <div className="note">
          Got a link from your coach? <button onClick={onRestore}>Open it here</button> to load
          the squad.
        </div>
      </div>

      <div className="footer">
        <button
          className="btn btn--primary"
          disabled={names.length < 2}
          onClick={() => onStart(names, teamName)}
        >
          {names.length < 2 ? 'Add at least two players' : `Start with ${names.length} players`}
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

export function SettingsScreen({ state, onChange, onDone, onPlayers, onNewGame }) {
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
          label="Total game time"
          value={s.totalGameMinutes}
          min={20}
          max={90}
          step={5}
          onChange={(v) => set({ totalGameMinutes: v })}
          format={(v) => `${v} min`}
        />
        <Slider
          label="Periods"
          value={s.periods}
          min={1}
          max={4}
          onChange={(v) => set({ periods: v })}
          format={(v) => `${v} × ${E.formatMs((s.totalGameMinutes * 60000) / v)}`}
        />

        {advice && !advice.evenlyDivides && advice.suggestedRotationSeconds && (
          <div className="note note--advice">
            <strong>These settings end mid-rotation.</strong> The queue only comes out even after{' '}
            {advice.cycle} subs, and this game fits {advice.rotationsInGame}. Some players will
            finish several minutes ahead of others.{' '}
            <button
              onClick={() => set({ rotationSeconds: advice.suggestedRotationSeconds })}
            >
              Use {E.formatMs(advice.suggestedRotationSeconds * 1000)} instead
            </button>{' '}
            and everyone gets {advice.everyPlayerMinutes} minutes.
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
          label="Show time above or below average"
          on={s.showFairnessDeviation}
          onChange={(v) => set({ showFairnessDeviation: v })}
        />
        <Toggle
          label="Keeper minutes count as playing time"
          on={s.keeperTimeCounts}
          onChange={(v) => set({ keeperTimeCounts: v })}
        />
        <Toggle
          label="Pause the game clock during dialogs"
          on={s.pauseGameClockOnDialog}
          onChange={(v) => set({ pauseGameClockOnDialog: v })}
        />
        <div className="note">
          Off by default so the clock matches the referee's. Turn it on if you're the one keeping
          official time.
        </div>

        <button
          className="btn btn--full"
          style={{ marginTop: 20, color: 'var(--off)', borderColor: 'var(--off)' }}
          onClick={onNewGame}
        >
          Reset timers and start a new game
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
    if (canvas.current) {
      // High error correction: this gets scanned off a phone screen in sunlight.
      QRCode.toCanvas(canvas.current, link, {
        errorCorrectionLevel: 'H',
        margin: 1,
        width: 600,
      }).catch(() => {});
    }
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

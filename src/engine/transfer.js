// §9.3 — move a game between phones with no backend.
//
// One mechanism, three jobs: pre-game handoff, mid-game device transfer, and
// the post-game report going back to the coach. The payload rides in the URL
// fragment so it never reaches a server, and it is rendered as a QR so the
// handoff works with no signal at all.

import { createGame, playedMs, DEFAULT_SETTINGS } from './rotation.js';

export const SCHEMA_VERSION = 1;

const b64urlEncode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDecode = (str) => {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/** Only store settings that differ from the defaults — keeps the QR small. */
const diffSettings = (settings) =>
  Object.fromEntries(
    Object.entries(settings).filter(([k, v]) => DEFAULT_SETTINGS[k] !== v)
  );

export function encodeGame(state, kind = 'live', teamName = '') {
  const payload = {
    v: SCHEMA_VERSION,
    t: kind,
    n: teamName || undefined,
    s: diffSettings(state.settings),
    // Tuples rather than objects: roughly a third of the characters.
    // playedMs, not accumulatedMs: players currently on the field have an
    // in-progress stint that hasn't been banked yet, and encoding the banked
    // figure would silently drop up to a full stint each on handover.
    p: state.order.map((id) => {
      const pl = state.players.find((x) => x.id === id);
      return [
        pl.name,
        Math.round(playedMs(state, id) / 1000),
        pl.unavailable ? 1 : 0,
        pl.heldOn ? 1 : 0,
      ];
    }),
    c: kind === 'setup' ? undefined : [
      state.clock.period,
      Math.round(state.clock.periodElapsedMs / 1000),
      Math.round(state.clock.lastRotationMs / 1000),
    ],
    sc: kind === 'setup' ? undefined : state.score,
    gs: kind === 'setup' || !state.scorers?.length
      ? undefined
      : state.scorers.map((g) => [g.name ?? '', Math.round(g.atMs / 1000)]),
  };
  return b64urlEncode(JSON.stringify(payload));
}

export function buildLink(state, kind = 'setup', teamName = '', origin) {
  const base = origin ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '');
  return `${base}#g=${encodeGame(state, kind, teamName)}`;
}

export class TransferError extends Error {}

export function decodeGame(encoded) {
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(encoded));
  } catch {
    throw new TransferError("That link is damaged. Ask for a new one.");
  }
  if (typeof payload?.v !== 'number') {
    throw new TransferError("That link isn't a saved game.");
  }
  // Refuse rather than guess. Silently mis-reading a future schema is how you
  // corrupt someone's game half an hour before kick-off.
  if (payload.v > SCHEMA_VERSION) {
    throw new TransferError(
      'That link was made with a newer version of the app. Update this device, then open it again.'
    );
  }

  const names = (payload.p ?? []).map(([name]) => name);
  const state = createGame(names, payload.s ?? {});
  (payload.p ?? []).forEach(([, seconds, unavailable, heldOn], i) => {
    state.players[i].accumulatedMs = (seconds ?? 0) * 1000;
    if (unavailable) state.players[i].unavailable = { reason: 'other', atMs: 0 };
    if (heldOn) state.players[i].heldOn = true;
  });
  if (payload.c) {
    state.clock.period = payload.c[0] ?? 1;
    state.clock.periodElapsedMs = (payload.c[1] ?? 0) * 1000;
    state.clock.lastRotationMs = (payload.c[2] ?? 0) * 1000;
  }
  if (payload.sc) state.score = payload.sc;
  if (payload.gs) {
    state.scorers = payload.gs.map(([name, seconds]) => ({
      id: state.players.find((p) => p.name === name)?.id ?? null,
      name: name || null,
      atMs: (seconds ?? 0) * 1000,
    }));
  }
  return { state, kind: payload.t ?? 'setup', teamName: payload.n ?? '' };
}

/** Pull an incoming payload out of the URL and clear it so a refresh is clean. */
export function readIncomingLink() {
  if (typeof location === 'undefined') return null;
  const match = location.hash.match(/[#&]g=([A-Za-z0-9\-_]+)/);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return match[1];
}

// §10.4 — Safari clears script-writable storage after seven days without
// interaction, and this app is used once a week. Home-screen installs are
// exempt, so the real fix is the install prompt; this layer just does what it
// can and never pretends a write succeeded when it didn't.

const GAME_KEY = 'subs.game.v1';
const TEAM_KEY = 'subs.team.v1';
const SEEN_KEY = 'subs.seenCoachmark.v1';

let warned = false;

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('Storage unavailable — the game will not survive a refresh.', err);
    }
    return false;
  }
}

/** Ask the browser not to evict us. Chrome honours it; Safari is undocumented. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* not fatal */
  }
  return false;
}

export const saveGame = (state) => safeSet(GAME_KEY, JSON.stringify(state));

export function loadGame() {
  const raw = safeGet(GAME_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export const clearGame = () => {
  try {
    localStorage.removeItem(GAME_KEY);
  } catch {
    /* ignore */
  }
};

/** The saved squad, so nobody retypes eleven names on a Saturday morning (§9.5). */
export const saveTeam = (team) => safeSet(TEAM_KEY, JSON.stringify(team));

export function loadTeam() {
  const raw = safeGet(TEAM_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const hasSeenCoachmark = () => safeGet(SEEN_KEY) === '1';
export const markCoachmarkSeen = () => safeSet(SEEN_KEY, '1');

export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.navigator?.standalone === true);

export const isIOS = () =>
  typeof navigator !== 'undefined' &&
  /iPad|iPhone|iPod/.test(navigator.userAgent) &&
  !window.MSStream;

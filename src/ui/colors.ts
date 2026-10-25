// Ticket colour scheme: owner colours the card outline / circle stroke, state the stripe / circle fill.
// Kept per Mac in localStorage (works in Demo mode and before Jira is set up, and never reconnects).

export type ColorKey = 'own-mine' | 'own-other' | 'own-none' | 'st-blocked' | 'st-ready' | 'st-prog' | 'st-done';
export type Colors = Record<ColorKey, string>;

export const OWNER_KEYS: [ColorKey, string][] = [
  ['own-mine', 'Mine'],
  ['own-other', 'Others'],
  ['own-none', 'Unassigned'],
];
export const STATE_KEYS: [ColorKey, string][] = [
  ['st-blocked', 'Blocked'],
  ['st-ready', 'Ready'],
  ['st-prog', 'In progress'],
  ['st-done', 'Done'],
];

/** Mono stays within the original grey + teal palette; its values are the :root defaults in styles.css. */
export const PRESETS: Record<'mono' | 'vivid', Colors> = {
  mono: {
    'own-mine': '#8a8d91',
    'own-other': '#303030',
    'own-none': '#303030',
    'st-blocked': '#f2f2f2',
    'st-ready': '#3fd6c6',
    'st-prog': '#8a8d91',
    'st-done': '#2a2a2a',
  },
  vivid: {
    'own-mine': '#3fd6c6',
    'own-other': '#3a3a3a',
    'own-none': '#5a5a5a',
    'st-blocked': '#ff6b6b',
    'st-ready': '#4ade80',
    'st-prog': '#fbbf24',
    'st-done': '#3a3a3a',
  },
};

const STORE = 'jirapowder.colors';
const HEX = /^#[0-9a-f]{6}$/i;

export function loadColors(): Colors {
  const c = { ...PRESETS.mono };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, unknown>;
    for (const k of Object.keys(c) as ColorKey[]) {
      const v = saved[k];
      if (typeof v === 'string' && HEX.test(v)) c[k] = v.toLowerCase();
    }
  } catch {
    /* storage unavailable or corrupt: defaults */
  }
  return c;
}

export function saveColors(c: Colors) {
  try {
    localStorage.setItem(STORE, JSON.stringify(c));
  } catch {
    /* not persisted, still applied */
  }
}

export function applyColors(c: Colors) {
  const s = document.documentElement.style;
  for (const k of Object.keys(c) as ColorKey[]) s.setProperty('--c-' + k, c[k]);
}

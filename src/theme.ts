import { useSyncExternalStore } from 'react';

// Light / dark UI. The choice ('system' follows the OS) is a per-machine preference kept in
// localStorage; the resolved theme goes on <html data-theme>, which switches the CSS tokens in
// styles.css. Konva can't read CSS variables, so canvas chrome colours live here.

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'spread.theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
const listeners = new Set<() => void>();

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // storage unavailable
  }
  return 'system';
}

let pref = readPref();
let resolved: Theme = resolve();
let snapshot = { pref, theme: resolved };

function resolve(): Theme {
  return pref === 'system' ? (media?.matches ? 'light' : 'dark') : pref;
}

function apply() {
  resolved = resolve();
  snapshot = { pref, theme: resolved };
  document.documentElement.dataset.theme = resolved;
  listeners.forEach((l) => l());
}

export function setThemePref(p: ThemePref) {
  pref = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    // storage unavailable; the choice lasts for this session
  }
  apply();
}

/** Call once before the first render so the page never flashes the wrong theme. */
export function initTheme() {
  media?.addEventListener('change', () => pref === 'system' && apply());
  apply();
}

export function useTheme() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/** Canvas chrome drawn by Konva: the dim outside the boards and the board outlines. */
export const CANVAS_CHROME: Record<Theme, { dim: string; outline: string; outlineHover: string }> = {
  dark: { dim: 'rgba(20,20,22,0.82)', outline: 'rgba(255,255,255,0.12)', outlineHover: 'rgba(255,255,255,0.35)' },
  light: { dim: 'rgba(230,230,233,0.85)', outline: 'rgba(0,0,0,0.10)', outlineHover: 'rgba(0,0,0,0.30)' },
};

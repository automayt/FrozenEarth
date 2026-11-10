import { useSyncExternalStore } from 'react';

/**
 * Player preferences, kept in this browser. The renderer and the UI read `settings` directly;
 * anything that needs to react to a change subscribes with onSettings or useSettings.
 * Audio is not here: audio.ts owns its own volumes, and the Audio section of the settings screen
 * talks to it directly.
 */
export type WeatherDensity = 'off' | 'light' | 'full';

export interface Settings {
  /** Size of the in-game interface. Small windows cap it (see effectiveUiScale). */
  uiScale: number;
  plantSway: boolean;
  weather: WeatherDensity;
  /** Baked sun shadows. */
  shadows: boolean;
  /** Birds, fireflies and falling leaves. */
  wildlife: boolean;
  /** Footprints, breath in the cold, campfire smoke. */
  details: boolean;
  screenShake: boolean;
  reducedMotion: boolean;
  /** Pan when the mouse rests against the edge of the screen. */
  edgeScroll: boolean;
  /** Let the camera go and look when something big happens. */
  bigMoments: boolean;
  fullscreen: boolean;
}

export type Quality = 'low' | 'medium' | 'high';
export type GraphicsKey = 'plantSway' | 'weather' | 'shadows' | 'wildlife' | 'details';

export const QUALITY: Record<Quality, Pick<Settings, GraphicsKey>> = {
  low: { plantSway: false, weather: 'light', shadows: false, wildlife: false, details: false },
  medium: { plantSway: true, weather: 'light', shadows: true, wildlife: false, details: true },
  high: { plantSway: true, weather: 'full', shadows: true, wildlife: true, details: true },
};

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.4;

/** Raindrops and snowflakes on screen, as a share of the full number. */
export const WEATHER_DENSITY: Record<WeatherDensity, number> = { off: 0, light: 0.45, full: 1 };

const KEY = 'fe.settings';

/** The layout the HUD needs, in interface pixels: the command bar at full width and the panels stop fitting below this. */
const MIN_LAYOUT_W = 1000;
const MIN_LAYOUT_H = 520;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function defaults(): Settings {
  return { uiScale: 1, ...QUALITY.high, screenShake: true, reducedMotion: prefersReducedMotion(), edgeScroll: true, bigMoments: true, fullscreen: false };
}

/** Whatever was stored, made safe: unknown keys are dropped and bad values fall back to the default. */
export function sanitize(raw: unknown, base: Settings = defaults()): Settings {
  const out = { ...base };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const scale = r.uiScale;
  if (typeof scale === 'number' && Number.isFinite(scale)) out.uiScale = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round(scale * 20) / 20));
  for (const k of ['plantSway', 'shadows', 'wildlife', 'details', 'screenShake', 'reducedMotion', 'edgeScroll', 'bigMoments', 'fullscreen'] as const) {
    const v = r[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  if (r.weather === 'off' || r.weather === 'light' || r.weather === 'full') out.weather = r.weather;
  return out;
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    return defaults();
  }
}

function save(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage blocked: the settings just last until the page closes.
  }
}

/** The preset the current graphics options match, or null when they've been mixed by hand. */
export function qualityOf(s: Settings): Quality | null {
  for (const q of ['low', 'medium', 'high'] as const) {
    const p = QUALITY[q];
    if (p.plantSway === s.plantSway && p.weather === s.weather && p.shadows === s.shadows && p.wildlife === s.wildlife && p.details === s.details) return q;
  }
  return null;
}

/** The chosen scale, held down so the HUD still fits the window. It never shrinks below what was chosen: small windows have their own layouts. */
export function effectiveUiScale(scale: number, w: number, h: number): number {
  return Math.min(scale, Math.max(1, w / MIN_LAYOUT_W), Math.max(1, h / MIN_LAYOUT_H));
}

/** Read this rather than storing a copy: it's replaced when a setting is saved. */
export let settings: Settings = load();
let version = 0;
const listeners = new Set<() => void>();

export function onSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function updateSettings(patch: Partial<Settings>): void {
  settings = sanitize({ ...settings, ...patch }, settings);
  save(settings);
  apply();
  version++;
  for (const l of listeners) l();
}

export function useSettings(): Settings {
  useSyncExternalStore(onSettings, () => version);
  return settings;
}

/** The HUD scale in force now: what interface pixels are multiplied by on screen. */
export function uiScale(): number {
  if (typeof window === 'undefined') return settings.uiScale;
  return effectiveUiScale(settings.uiScale, window.innerWidth, window.innerHeight);
}

/** Push the settings the stylesheet cares about onto the page. */
function apply(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', uiScale().toFixed(3));
  root.toggleAttribute('data-calm', settings.reducedMotion);
}

if (typeof window !== 'undefined') {
  apply();
  window.addEventListener('resize', apply);
}

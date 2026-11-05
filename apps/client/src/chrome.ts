import { onSettings, settings, updateSettings } from './settings';

/**
 * Everything that gives away "this is a web page": the browser's context menu, page zoom and
 * fullscreen handling. Text selection and focus rings are in game.css.
 */

function isField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, .chat .lines, .selectable');
}

/** Lets Esc reach the game in fullscreen (Chromium over https or localhost; elsewhere Esc just leaves fullscreen). */
function lockEscape(on: boolean): void {
  const kb = (navigator as Navigator & { keyboard?: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
  try {
    if (on) void kb?.lock?.(['Escape'])?.catch(() => {});
    else kb?.unlock?.();
  } catch {
    // Not available: harmless.
  }
}

function enterFullscreen(): void {
  if (document.fullscreenElement) return;
  document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.then(
    () => lockEscape(true),
    // Refused (not allowed in this frame, say): say so on the toggle rather than claim it's on.
    () => {
      if (settings.fullscreen) updateSettings({ fullscreen: false });
    },
  );
}

function leaveFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
}

export function toggleFullscreen(): void {
  updateSettings({ fullscreen: !settings.fullscreen });
}

export function installChrome(): void {
  document.addEventListener('contextmenu', (e) => {
    if (!isField(e.target)) e.preventDefault();
  });
  document.addEventListener('dragstart', (e) => e.preventDefault());
  // Page zoom: Ctrl+wheel, pinch (which arrives as Ctrl+wheel) and Ctrl with + - 0.
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false },
  );
  // Capture: these work whatever has the keyboard, the Escape menu included.
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
      if (e.key === 'F11') {
        e.preventDefault();
        toggleFullscreen();
      }
    },
    true,
  );
  // The setting and the window stay in step, whichever one changed.
  onSettings(() => (settings.fullscreen ? enterFullscreen() : leaveFullscreen()));
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    lockEscape(on);
    if (on !== settings.fullscreen) updateSettings({ fullscreen: on });
  });
  // Browsers only go fullscreen from a gesture, so a saved preference waits for the first one.
  if (settings.fullscreen) {
    const once = () => {
      window.removeEventListener('pointerdown', once);
      window.removeEventListener('keydown', once);
      enterFullscreen();
    };
    window.addEventListener('pointerdown', once);
    window.addEventListener('keydown', once);
  }
}

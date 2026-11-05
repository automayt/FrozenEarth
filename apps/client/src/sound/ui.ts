import type { Command } from '@fe/sim';
import type { Kind } from './recipes';

/**
 * Interface sounds with no per-component code: one delegated listener covers every button, and
 * panels, refusals and selection are noticed from the store.
 */

/** What counts as something you can press. */
const PRESSABLE = 'button, a[href], select, summary, [role="button"], [role="tab"], input[type="range"], input[type="checkbox"], input[type="radio"]';
const DISABLED = ':disabled, [aria-disabled="true"]';

interface Press {
  closest(selector: string): Press | null;
  matches(selector: string): boolean;
}

/** The control under a pointer, ignoring anything that isn't one. */
export function pressableAt(target: EventTarget | null): Press | null {
  const el = target as Press | null;
  return typeof el?.closest === 'function' ? el.closest(PRESSABLE) : null;
}

export function isDisabled(el: Press): boolean {
  return el.matches(DISABLED);
}

/** The sound of an order: a blueprint knocks in, marks on the map are quieter. */
export function commandSound(c: Command['c']): Kind | null {
  switch (c) {
    case 'build':
      return 'place';
    case 'designate':
    case 'zone':
    case 'unzone':
    case 'deconstruct':
    case 'packUp':
    case 'move':
    case 'attack':
    case 'capture':
    case 'hunt':
    case 'tame':
    case 'draft':
      return 'mark';
    default:
      return null;
  }
}

/** The bits of the store that make a sound when they change. */
export interface UiState {
  panel: string;
  menu: string | null;
  help: boolean;
  selected: number | null;
  /** Highest toast id shown, and the tone of the newest. */
  toast: number;
  toastBad: boolean;
}

/** What to play for a change in the interface; a panel swapping for another counts as opening. */
export function uiChange(was: UiState, is: UiState): Kind[] {
  const out: Kind[] = [];
  const shown = (s: UiState) => (s.panel !== 'none' ? 1 : 0) + (s.help ? 1 : 0) + (s.menu ? 1 : 0);
  const changed = was.panel !== is.panel || was.menu !== is.menu || was.help !== is.help;
  if (changed) out.push(shown(is) >= shown(was) ? 'open' : 'close');
  if (is.toast > was.toast && is.toastBad) out.push('refuse');
  if (is.selected !== null && is.selected !== was.selected) out.push('select');
  return out;
}

/** Hover ticks and click sounds for every control in the page. */
export function listenForPresses(play: (kind: Kind) => void): void {
  let over: Press | null = null;
  document.addEventListener(
    'pointerover',
    (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = pressableAt(e.target);
      if (el === over) return;
      over = el;
      if (el && !isDisabled(el)) play('hover');
    },
    { passive: true },
  );
  document.addEventListener(
    'click',
    (e) => {
      const el = pressableAt(e.target);
      if (el && !isDisabled(el)) play('press');
    },
    { capture: true, passive: true },
  );
  // Disabled controls swallow their clicks, but a press on one should still answer.
  document.addEventListener(
    'pointerdown',
    (e) => {
      const el = pressableAt(e.target);
      if (el && isDisabled(el)) play('refuse');
    },
    { capture: true, passive: true },
  );
}

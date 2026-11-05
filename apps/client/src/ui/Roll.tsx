import { useRef } from 'react';

interface Cell {
  ch: string;
  /** The character this one replaced, sliding out as it arrives. */
  was?: string;
  dir?: 'up' | 'down';
  key: string;
}

let nextKey = 1;

/**
 * Lines the new text up against the old from the right, so digits keep their place value, and
 * marks the ones that changed. `prev` keeps the keys of cells that stay.
 */
export function rollCells(text: string, prev: Cell[] | null, dir: 'up' | 'down'): Cell[] {
  const chars = [...text];
  return chars.map((ch, i) => {
    const old = prev?.[prev.length - chars.length + i];
    if (old && old.ch === ch) return { ch, key: old.key };
    const digit = /\d/.test(ch);
    return { ch, key: `c${nextKey++}`, was: digit && old && /\d/.test(old.ch) ? old.ch : undefined, dir: digit && old ? dir : undefined };
  });
}

/** A number whose changed digits roll into place. The stylesheet turns the motion off when asked. */
export function Roll({ value, text, className = '' }: { value: number; text?: string; className?: string }) {
  const shown = text ?? String(value);
  const state = useRef<{ shown: string; value: number; cells: Cell[] } | null>(null);
  if (state.current?.shown !== shown) {
    const prev = state.current;
    state.current = { shown, value, cells: rollCells(shown, prev?.cells ?? null, !prev || value >= prev.value ? 'up' : 'down') };
  }
  return (
    <span className={`roll ${className}`} aria-label={shown}>
      {state.current.cells.map((c) => (
        <span key={c.key} className={`roll-d ${c.dir ?? ''}`} data-was={c.was} aria-hidden="true">
          {c.ch}
        </span>
      ))}
    </span>
  );
}

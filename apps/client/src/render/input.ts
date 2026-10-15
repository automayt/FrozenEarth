import type { Graphics } from 'pixi.js';
import { BUILDINGS } from '@fe/defs';
import { pawnPosition } from '@fe/protocol';
import type { Pawn, Rect } from '@fe/sim';
import { command } from '../net';
import { store } from '../store';
import { mySquad, setSpeed, toggleDraft, togglePause } from '../actions';
import { TILE, type GameRenderer } from './renderer';

interface Drag {
  start: { x: number; y: number };
  cur: { x: number; y: number };
}

const PAN_SPEED = 900;

export class Input {
  private keys = new Set<string>();
  private drag: Drag | null = null;
  private pan: { x: number; y: number; moved: boolean } | null = null;
  private off: (() => void)[] = [];

  constructor(
    private r: GameRenderer,
    private el: HTMLCanvasElement,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(el, 'pointerdown', (e) => this.down(e));
    on(window, 'pointermove', (e) => this.move(e));
    on(window, 'pointerup', (e) => this.up(e));
    on(el, 'contextmenu', (e) => e.preventDefault());
    on(el, 'wheel', (e) => this.wheel(e), { passive: false });
    on(window, 'keydown', (e) => this.key(e, true));
    on(window, 'keyup', (e) => this.key(e, false));
    on(window, 'blur', () => this.keys.clear());
  }

  destroy(): void {
    for (const f of this.off) f();
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const b = this.el.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  private down(e: PointerEvent): void {
    const p = this.local(e);
    if (e.button === 1 || e.button === 2) {
      this.pan = { x: e.clientX, y: e.clientY, moved: false };
      return;
    }
    if (e.button !== 0) return;
    const cell = this.r.screenToCell(p.x, p.y);
    if (store.me?.faction === 0) {
      if (store.mirror.inBounds(cell.x, cell.y)) store.set({ settlePick: cell });
      return;
    }
    // With the select tool a drag draws a box around colonists; a click selects what's under it.
    this.drag = { start: cell, cur: cell };
  }

  private move(e: PointerEvent): void {
    if (this.pan) {
      const dx = e.clientX - this.pan.x;
      const dy = e.clientY - this.pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.pan.moved = true;
      this.r.world.x += dx;
      this.r.world.y += dy;
      this.pan.x = e.clientX;
      this.pan.y = e.clientY;
    }
    if (e.target !== this.el && !this.drag) return;
    const p = this.local(e);
    const cell = this.r.screenToCell(p.x, p.y);
    if (this.drag) this.drag.cur = cell;
    const m = store.mirror;
    const hc = m.inBounds(cell.x, cell.y) ? m.idx(cell.x, cell.y) : null;
    if (hc !== store.hoverCell) store.set({ hoverCell: hc });
  }

  private up(e: PointerEvent): void {
    if (this.pan && (e.button === 1 || e.button === 2)) {
      const clicked = !this.pan.moved && e.button === 2;
      this.pan = null;
      if (clicked) {
        if (store.tool.kind !== 'select') store.set({ tool: { kind: 'select' } });
        else if (!this.order(e)) store.set({ selected: null, selectedCell: null, squad: [] });
      }
      return;
    }
    if (e.button !== 0 || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    const rect: Rect = { x0: d.start.x, y0: d.start.y, x1: d.cur.x, y1: d.cur.y };
    const t = store.tool;
    switch (t.kind) {
      case 'select': {
        const p = this.local(e);
        if (d.start.x === d.cur.x && d.start.y === d.cur.y) this.select(p.x, p.y);
        else this.boxSelect(rect);
        break;
      }
      case 'designate':
        command({ c: 'designate', kind: t.what, ...rect });
        break;
      case 'build':
        command({ c: 'build', def: t.def, hollow: true, ...rect });
        break;
      case 'zone':
        command({ c: 'zone', kind: t.zone, plant: t.plant, ...rect });
        break;
      case 'unzone':
        command({ c: 'unzone', ...rect });
        break;
      case 'deconstruct':
        command({ c: 'deconstruct', ...rect });
        break;
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    this.r.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  }

  private key(e: KeyboardEvent, down: boolean): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (!down) return;
    if (k === 'escape') {
      if (store.tool.kind !== 'select') store.set({ tool: { kind: 'select' } });
      else if (store.menu || store.panel !== 'none') store.set({ menu: null, panel: 'none' });
      else store.set({ selected: null, selectedCell: null, squad: [] });
    } else if (k === ' ') {
      e.preventDefault();
      togglePause();
    } else if (k === '1' || k === '2' || k === '3') {
      setSpeed(Number(k));
    } else if (k === 'r') {
      toggleDraft();
    } else if (k === 'h') {
      const f = store.me ? store.mirror.factions.get(store.me.faction) : undefined;
      if (f) store.set({ focus: { ...f.home } });
    }
  }

  update(dtMs: number): void {
    const step = (PAN_SPEED * dtMs) / 1000;
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) this.r.world.y += step;
    if (k.has('s') || k.has('arrowdown')) this.r.world.y -= step;
    if (k.has('a') || k.has('arrowleft')) this.r.world.x += step;
    if (k.has('d') || k.has('arrowright')) this.r.world.x -= step;
  }

  /** Own pawn ids under a dragged box. */
  private boxSelect(r: Rect): void {
    const m = store.mirror;
    const tick = store.estTick();
    const x0 = Math.min(r.x0, r.x1);
    const x1 = Math.max(r.x0, r.x1);
    const y0 = Math.min(r.y0, r.y1);
    const y1 = Math.max(r.y0, r.y1);
    const ids: number[] = [];
    for (const e of m.entities.values()) {
      if (e.kind !== 'pawn' || e.faction !== store.me?.faction) continue;
      const pos = pawnPosition(e, tick, m.w);
      const x = Math.round(pos.x);
      const y = Math.round(pos.y);
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) ids.push(e.id);
    }
    store.set({ squad: ids, selected: ids[0] ?? null, selectedCell: null });
  }

  /** The pawn drawn closest to a screen point, if any is near enough. */
  private pawnAt(sx: number, sy: number, prefer?: (p: Pawn) => boolean): number | null {
    const m = store.mirror;
    const wp = this.r.screenToWorld(sx, sy);
    const tick = store.estTick();
    let best: number | null = null;
    let bestD = 0.7;
    for (const e of m.entities.values()) {
      if (e.kind !== 'pawn') continue;
      const pos = pawnPosition(e, tick, m.w);
      const d = Math.hypot(pos.x + 0.5 - wp.x, pos.y + 0.5 - wp.y) - (prefer?.(e) ? 0.1 : 0);
      if (d < bestD) {
        bestD = d;
        best = e.id;
      }
    }
    return best;
  }

  /** Right-click with drafted colonists selected: attack whoever is under the cursor, or move there. */
  private order(e: PointerEvent): boolean {
    const squad = mySquad().filter((p) => p.drafted && !p.downed);
    if (!squad.length) return false;
    const p = this.local(e);
    const ids = squad.map((s) => s.id);
    const target = this.pawnAt(p.x, p.y, (o) => o.faction !== store.me?.faction);
    const t = target ? store.mirror.get<Pawn>(target) : undefined;
    if (t && t.faction !== store.me?.faction) {
      command({ c: 'attack', pawns: ids, target: t.id });
      this.r.flashOrder(t.x, t.y, true);
      return true;
    }
    const cell = this.r.screenToCell(p.x, p.y);
    if (!store.mirror.inBounds(cell.x, cell.y)) return true;
    command({ c: 'move', pawns: ids, x: cell.x, y: cell.y });
    this.r.flashOrder(cell.x, cell.y, false);
    return true;
  }

  private select(sx: number, sy: number): void {
    const m = store.mirror;
    const wp = this.r.screenToWorld(sx, sy);
    const cx = Math.floor(wp.x);
    const cy = Math.floor(wp.y);
    if (!m.inBounds(cx, cy)) {
      store.set({ selected: null, selectedCell: null, squad: [] });
      return;
    }
    const pawn = this.pawnAt(sx, sy, (e) => e.faction === store.me?.faction);
    const c = m.idx(cx, cy);
    const best = pawn ?? (m.buildingAt[c] || m.constructAt[c] || m.itemAt[c] || m.plantAt[c] || null);
    const own = pawn !== null && m.get(pawn)?.faction === store.me?.faction;
    store.set({ selected: best, selectedCell: c, squad: own ? [pawn] : [] });
  }

  /** Draw the drag rectangle for the active tool. */
  drawPreview(g: Graphics): void {
    const t = store.tool;
    const m = store.mirror;
    const s = 1 / this.r.world.scale.x;
    if (this.drag && t.kind === 'select') {
      const d = this.drag;
      if (d.start.x === d.cur.x && d.start.y === d.cur.y) return;
      const bx = Math.min(d.start.x, d.cur.x);
      const by = Math.min(d.start.y, d.cur.y);
      const bw = Math.abs(d.cur.x - d.start.x) + 1;
      const bh = Math.abs(d.cur.y - d.start.y) + 1;
      g.rect(bx * TILE, by * TILE, bw * TILE, bh * TILE).fill({ color: 0xffffff, alpha: 0.06 }).stroke({ width: 1.5 * s, color: 0xffffff, alpha: 0.7 });
      return;
    }
    if (!this.drag) {
      // Hover outline for the cell under the cursor.
      if (t.kind !== 'select' && store.hoverCell !== null) {
        const c = store.hoverCell;
        g.rect((c % m.w) * TILE, ((c / m.w) | 0) * TILE, TILE, TILE).stroke({ width: 1.5 * s, color: 0xffffff, alpha: 0.5 });
      }
      return;
    }
    const x0 = Math.max(0, Math.min(this.drag.start.x, this.drag.cur.x));
    const x1 = Math.min(m.w - 1, Math.max(this.drag.start.x, this.drag.cur.x));
    const y0 = Math.max(0, Math.min(this.drag.start.y, this.drag.cur.y));
    const y1 = Math.min(m.h - 1, Math.max(this.drag.start.y, this.drag.cur.y));
    const color =
      t.kind === 'designate' ? (t.what === 'cancel' ? 0xe05a4a : 0xf0b43c) : t.kind === 'build' ? 0x8ac8ff : t.kind === 'zone' ? (t.zone === 'grow' ? 0x7ac04a : 0xe0c060) : 0xe05a4a;
    const hollow = t.kind === 'build' && !!BUILDINGS[t.def]?.wall && x1 - x0 >= 2 && y1 - y0 >= 2;
    if (hollow) {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) if (x === x0 || x === x1 || y === y0 || y === y1) g.rect(x * TILE, y * TILE, TILE, TILE).fill({ color, alpha: 0.3 });
    } else {
      g.rect(x0 * TILE, y0 * TILE, (x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE).fill({ color, alpha: 0.2 });
    }
    g.rect(x0 * TILE, y0 * TILE, (x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE).stroke({ width: 2 * s, color, alpha: 0.9 });
  }
}

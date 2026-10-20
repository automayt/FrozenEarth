import type { Graphics } from 'pixi.js';
import { BUILDINGS, ITEMS, WEAPONS } from '@fe/defs';
import { pawnPosition } from '@fe/protocol';
import { attackRefusal, atWar, dispositionOf, type Pawn, type Rect, MAX_VIA } from '@fe/sim';
import { command } from '../net';
import { store } from '../store';
import { sound } from '../audio';
import { helpers, mySquad, setSpeed, toggleDraft, togglePause } from '../actions';
import { TILE, type GameRenderer } from './renderer';

interface Drag {
  start: { x: number; y: number };
  cur: { x: number; y: number };
}

const PAN_SPEED = 900;

const STEER_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

/** Panels and menus with their own key. */
const PANEL_KEYS: Record<string, 'work' | 'colonists' | 'trade' | 'diplomacy' | 'chronicle'> = { p: 'work', l: 'colonists', t: 'trade', g: 'diplomacy', j: 'chronicle' };
const MENU_KEYS: Record<string, string> = { o: 'orders', z: 'zones', b: 'structure' };

/** How long a "right-click again to attack" warning stays armed. */
const CONFIRM_MS = 3000;

export class Input {
  private keys = new Set<string>();
  private drag: Drag | null = null;
  private pan: { x: number; y: number; moved: boolean } | null = null;
  private off: (() => void)[] = [];
  /** A peaceful target the player was warned about attacking; a second right-click confirms. */
  private armed: { target: number; until: number } | null = null;
  /** Times we've explained that right-click orders need drafted colonists (stop after a few). */
  private draftNags = 0;

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
    if (store.tool.kind === 'moveHome') {
      // Planning a journey: a click picks where to go; shift-click adds a waypoint on the way.
      if (store.mirror.inBounds(cell.x, cell.y)) {
        const j = store.journey ?? { dest: null, via: [], members: null, take: null };
        if (e.shiftKey && j.dest && j.via.length < MAX_VIA) store.set({ journey: { ...j, via: [...j.via, j.dest], dest: { x: cell.x, y: cell.y } } });
        else if (e.shiftKey && !j.dest) store.set({ journey: { ...j, dest: { x: cell.x, y: cell.y } } });
        else store.set({ journey: { ...j, dest: { x: cell.x, y: cell.y } } });
        this.r.flashOrder(cell.x, cell.y, false);
      }
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
        else if (!this.order(e)) {
          if (mySquad().some((p) => !p.downed) && this.draftNags++ < 3) store.toast('Right-click orders need drafted colonists: press R to draft the selection.', 'neutral');
          store.set({ selected: null, selectedCell: null, squad: [] });
        }
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
      case 'packUp':
        command({ c: 'packUp', ...rect });
        break;
      case 'deconstruct':
        command({ c: 'deconstruct', ...rect });
        break;
      case 'hunt': {
        const x0 = Math.min(rect.x0, rect.x1);
        const x1 = Math.max(rect.x0, rect.x1);
        const y0 = Math.min(rect.y0, rect.y1);
        const y1 = Math.max(rect.y0, rect.y1);
        const ids: number[] = [];
        for (const e of store.mirror.entities.values()) {
          if (e.kind === 'pawn' && e.species && e.x >= x0 - 1 && e.x <= x1 + 1 && e.y >= y0 - 1 && e.y <= y1 + 1) ids.push(e.id);
        }
        if (ids.length) {
          command({ c: 'hunt', pawns: ids, on: true });
          const n = ids.length;
          store.toast(`Marked ${n} animal${n > 1 ? 's' : ''} for hunting. Colonists with a bow or rifle will go after ${n > 1 ? 'them' : 'it'}.`, 'good');
        } else store.toast('No animals there. Drag over the animals you want hunted.', 'neutral');
        break;
      }
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    this.r.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  }

  private key(e: KeyboardEvent, down: boolean): void {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // Esc leaves a text box, so the game keys work again.
      if (down && e.key === 'Escape') el!.blur();
      return;
    }
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // The help overlay sits on top of everything and takes Esc (and ?) first.
    if (store.help) {
      if (down && (k === 'escape' || k === '?' || k === 'f1')) {
        e.preventDefault();
        store.set({ help: false });
      }
      return;
    }
    if (down && (k === '?' || k === 'f1')) {
      e.preventDefault();
      store.set({ help: true });
      return;
    }
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    // Steering a colonist: WASD walks them, C sneaks, E takes or drops, Esc lets go.
    const steering = this.r.controlled();
    if (steering) {
      if (STEER_KEYS.has(k)) {
        e.preventDefault();
        this.sendSteer(steering.id);
        return;
      }
      if (down && k === 'c') {
        command({ c: 'sneak', pawn: steering.id, on: !steering.sneaking });
        return;
      }
      if (down && k === 'e') {
        command({ c: 'interact', pawn: steering.id });
        return;
      }
      // Esc closes an open tool, menu or panel first; only then does it let go.
      if (down && k === 'escape' && store.tool.kind === 'select' && !store.menu && store.panel === 'none') {
        command({ c: 'possess', pawn: steering.id, on: false });
        return;
      }
    }
    if (!down) return;
    if (k === 'escape') {
      // One layer at a time: the active tool, then an open menu or panel, then the selection.
      if (store.tool.kind !== 'select') store.set({ tool: { kind: 'select' } });
      else if (store.menu || store.panel !== 'none') store.set({ menu: null, panel: 'none' });
      else store.set({ selected: null, selectedCell: null, squad: [] });
    } else if (k === 'enter') {
      const chat = document.querySelector<HTMLInputElement>('.chat input');
      if (chat) {
        e.preventDefault();
        chat.focus();
      }
    } else if (PANEL_KEYS[k] && store.me?.faction) {
      const panel = PANEL_KEYS[k];
      store.set({ panel: store.panel === panel ? 'none' : panel, menu: null });
    } else if (MENU_KEYS[k] && store.me?.faction) {
      const menu = MENU_KEYS[k];
      store.set({ menu: store.menu === menu ? null : menu, panel: 'none' });
    } else if (k === 'f') {
      const sel = store.selected ? store.mirror.get(store.selected) : undefined;
      const c = store.selectedCell;
      if (sel) store.set({ focus: { x: sel.x, y: sel.y } });
      else if (c !== null) store.set({ focus: { x: c % store.mirror.w, y: Math.floor(c / store.mirror.w) } });
    } else if (k === ' ') {
      e.preventDefault();
      togglePause();
    } else if (k === '1' || k === '2' || k === '3') {
      setSpeed(Number(k));
    } else if (k === 'r') {
      toggleDraft();
    } else if (k === 'm') {
      sound.toggleMute();
    } else if (k === 'h') {
      const f = store.me ? store.mirror.factions.get(store.me.faction) : undefined;
      if (f) store.set({ focus: { ...f.home } });
    }
  }

  private lastSteer = '';

  /** Tell the sim which way the held keys point; only when it changes. */
  private sendSteer(pawn: number): void {
    const k = this.keys;
    const dx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const dy = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0);
    const key = `${pawn}:${dx},${dy}`;
    if (key === this.lastSteer) return;
    this.lastSteer = key;
    command({ c: 'steer', pawn, dx, dy });
  }

  update(dtMs: number): void {
    const steering = this.r.controlled();
    if (steering) {
      this.r.follow(steering.id);
      return;
    }
    this.lastSteer = '';
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
      if (e.kind !== 'pawn' || e.faction !== store.me?.faction || e.prisoner) continue;
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

  /**
   * Right-click with drafted colonists selected: capture a downed raider, attack whoever else is
   * under the cursor, pick up a weapon lying there, or move there.
   */
  private order(e: PointerEvent): boolean {
    const squad = mySquad().filter((p) => p.drafted && !p.downed);
    if (!squad.length) return false;
    const p = this.local(e);
    const ids = squad.map((s) => s.id);
    const target = this.pawnAt(p.x, p.y, (o) => o.faction !== store.me?.faction);
    const t = target ? store.mirror.get<Pawn>(target) : undefined;
    if (t && t.faction !== store.me?.faction) {
      const f = store.mirror.factions.get(t.faction);
      const raider = !!f?.raid;
      if (t.downed && raider) {
        command({ c: 'capture', pawns: ids, target: t.id });
        store.toast(`Capturing ${t.name.split(' ')[0]}: they'll be carried to a free bed.`, 'neutral');
        this.r.flashOrder(t.x, t.y, false);
        return true;
      }
      // Allies and truces: your colonists won't (the server says the same).
      const refusal = attackRefusal(store.mirror, store.me!.faction, t.faction);
      if (refusal) {
        store.toast(refusal, 'bad');
        return true;
      }
      // Attacking someone you aren't at war with starts a war: ask once more first.
      const st = f?.settlement;
      const colonyAtPeace = !!f?.isPlayer && !atWar(store.mirror, store.me!.faction, t.faction);
      const peaceful = !t.species && !raider && !t.prisoner && (colonyAtPeace || (!!st && st.state !== 'fallen' && dispositionOf(st, store.me!.faction) !== 'hostile'));
      if (peaceful && !(this.armed?.target === t.id && performance.now() < this.armed.until)) {
        this.armed = { target: t.id, until: performance.now() + CONFIRM_MS };
        store.toast(
          f?.isPlayer
            ? `Right-click ${t.name.split(' ')[0]} again to attack. That is a surprise attack: it starts a war with ${f.name}, and every town that knows you hears of it.`
            : `Right-click ${t.name.split(' ')[0]} again to attack. ${f?.name} will treat you as enemies.`,
          'bad',
        );
        return true;
      }
      this.armed = null;
      command({ c: 'attack', pawns: ids, target: t.id });
      this.r.flashOrder(t.x, t.y, !t.downed);
      return true;
    }
    const cell = this.r.screenToCell(p.x, p.y);
    if (!store.mirror.inBounds(cell.x, cell.y)) return true;
    const it = store.mirror.get(store.mirror.itemAt[store.mirror.idx(cell.x, cell.y)]);
    // Goods in a settlement's or another colony's stockpile: the nearest drafted colonist goes to take them.
    const zone = store.mirror.zones.get(store.mirror.zoneAt[store.mirror.idx(cell.x, cell.y)]);
    const owner = zone ? store.mirror.factions.get(zone.faction) : undefined;
    if (it && it.kind === 'item' && zone?.kind === 'stockpile' && zone.faction !== store.me?.faction && (owner?.settlement || owner?.isPlayer)) {
      const who = squad.reduce((a, b) => (Math.hypot(b.x - cell.x, b.y - cell.y) < Math.hypot(a.x - cell.x, a.y - cell.y) ? b : a));
      command({ c: 'steal', pawn: who.id, item: it.id });
      store.toast(`${who.name.split(' ')[0]} goes to steal the ${ITEMS[it.def]?.label.toLowerCase() ?? 'goods'}. Anyone awake who sees it raises the alarm.`, 'neutral');
      this.r.flashOrder(cell.x, cell.y, true);
      return true;
    }
    if (it && it.kind === 'item' && WEAPONS[it.def]) {
      const who = helpers(cell.x, cell.y).find((s) => s.drafted) ?? squad[0];
      command({ c: 'equip', pawn: who.id, item: it.id });
      store.toast(`${who.name.split(' ')[0]} will pick up the ${ITEMS[it.def]?.label.toLowerCase() ?? 'weapon'}.`, 'neutral');
      this.r.flashOrder(cell.x, cell.y, false);
      return true;
    }
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

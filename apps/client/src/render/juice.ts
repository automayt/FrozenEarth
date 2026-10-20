import { BitmapText, Container, Graphics, TextStyle } from 'pixi.js';
import { ITEMS } from '@fe/defs';
import type { Mirror } from '@fe/protocol';
import type { Item, Pawn } from '@fe/sim';

/**
 * The game answering back. Colonists say a word at the moments that matter (a raid, a first
 * bed, the cold), and the goods a felled tree or mined rock gives float up from where it was.
 * Everything here is client-side and read from what the server already sends.
 */

const TILE = 32;
/** How long a bubble stays up, and how often one colonist may speak. */
const BARK_MS = 2800;
const BARK_GAP_MS = 9000;
/** Most bubbles on screen at once: more than this and nobody reads any of them. */
const MAX_BARKS = 4;
const GAIN_MS = 1600;
/** A new item counts as a harvest if it appears this close to a tree that just fell or rock just mined. */
const HARVEST_RADIUS = 1.6;
const HARVEST_WINDOW_MS = 2500;

const BUBBLE_TEXT = new TextStyle({ fontFamily: 'Signika', fontSize: 22, fontWeight: '600', fill: 0x2a2116 });
const GAIN_TEXT = new TextStyle({ fontFamily: 'Signika', fontSize: 24, fontWeight: '600', fill: 0xffffff, stroke: { color: 0x1a140c, width: 5 } });

/** What one colonist says at each kind of moment. */
const LINES: Record<string, string[]> = {
  raiders: ['Raiders!', 'Get inside!', 'Run!'],
  wolves: ['Wolves!', 'Back! Back!'],
  danger: ['Trouble!', 'Look out!'],
  drafted: ['Ready.', 'On it.', 'Say the word.'],
  downed: ['Ugh…', "I'm hit!"],
  bed: ['A bed of my own.', 'Finally, a bed.'],
  cold: ['So cold…', "Can't feel my hands."],
  starving: ['Starving…', 'Need food.'],
  cornered: ['Get away!', 'Come on then!'],
  road: ['On the road.', 'Onward.', 'Keep together.'],
  camp: ['Keep the fire going.', 'Rest while we can.'],
  miserable: ["I can't go on like this.", 'What are we doing here?'],
};

interface Seen {
  job: string;
  drafted: boolean;
  downed: boolean;
  bed: number;
  cold: boolean;
  low: boolean;
  phase: string;
}

interface Bark {
  pawn: number;
  root: Container;
  born: number;
}

interface Gain {
  root: BitmapText;
  born: number;
  y0: number;
}

const pick = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];

export class Juice {
  readonly view = new Container();
  private seen = new Map<number, Seen>();
  private lastBark = new Map<number, number>();
  private barks: Bark[] = [];
  private gains: Gain[] = [];
  private plants = new Map<number, number>();
  private items = new Set<number>();
  private cleared: { cell: number; at: number }[] = [];
  private primed = false;

  /** A rock cell was mined out this frame (the renderer already spots it for the dust). */
  rockMined(cell: number, now: number): void {
    this.cleared.push({ cell, at: now });
  }

  /**
   * Look at what changed since last frame. `me` is your faction; `pawnPos` gives where a pawn is
   * drawn (it glides between server updates).
   */
  frame(m: Mirror, me: number, changed: Set<number>, removed: Set<number>, now: number, pawnPos: (id: number) => { x: number; y: number } | null): void {
    // On the first look (joining), everything is new: learn it without fanfare.
    if (!this.primed) {
      for (const e of m.entities.values()) {
        if (e.kind === 'plant') this.plants.set(e.id, e.y * m.w + e.x);
        else if (e.kind === 'item') this.items.add(e.id);
        else if (e.kind === 'pawn' && e.faction === me) this.seen.set(e.id, this.state(e));
      }
      this.primed = true;
    }
    for (const id of removed) {
      const cell = this.plants.get(id);
      if (cell !== undefined) {
        this.cleared.push({ cell, at: now });
        this.plants.delete(id);
      }
      this.items.delete(id);
      this.seen.delete(id);
    }
    this.cleared = this.cleared.filter((c) => now - c.at < HARVEST_WINDOW_MS);
    for (const id of changed) {
      const e = m.entities.get(id);
      if (!e) continue;
      if (e.kind === 'plant') this.plants.set(id, e.y * m.w + e.x);
      else if (e.kind === 'item' && !this.items.has(id)) {
        this.items.add(id);
        this.maybeGain(m, e, now);
      } else if (e.kind === 'pawn' && e.faction === me && !e.species && !e.prisoner) this.watch(m, e, now);
    }
    this.animate(now, pawnPos);
  }

  private state(p: Pawn): Seen {
    return {
      job: p.job?.type ?? '',
      drafted: !!p.drafted,
      downed: !!p.downed,
      bed: p.bed ?? 0,
      cold: p.conditions.some((c) => c.key === 'hypothermia' && c.severity > 0.2),
      low: p.needs.mood < 0.18,
      phase: p.job?.type === 'trek' ? p.job.phase : '',
    };
  }

  /** Did something just happen to this colonist that they'd say a word about? */
  private watch(m: Mirror, p: Pawn, now: number): void {
    const was = this.seen.get(p.id);
    const is = this.state(p);
    this.seen.set(p.id, is);
    if (!was) return;
    let what: string | null = null;
    if (is.downed && !was.downed) what = 'downed';
    else if (is.job === 'shelter' && was.job !== 'shelter' && p.job?.type === 'shelter') {
      const threat = m.entities.get(p.job.from) as Pawn | undefined;
      const f = threat ? m.factions.get(threat.faction) : undefined;
      what = threat?.species ? 'wolves' : f?.raid ? 'raiders' : 'danger';
    } else if (is.job === 'attack' && was.job === 'shelter') what = 'cornered';
    else if (is.drafted && !was.drafted) what = 'drafted';
    else if (is.phase === 'travel' && was.phase !== 'travel') what = 'road';
    else if (is.job === 'sleep' && was.job === 'trek') what = 'camp';
    else if (is.bed && !was.bed) what = 'bed';
    else if (is.cold && !was.cold) what = 'cold';
    else if (is.job === 'eat' && was.job !== 'eat' && p.needs.food < 0.15) what = 'starving';
    else if (is.low && !was.low) what = 'miserable';
    if (what) this.say(p.id, pick(LINES[what]), now);
  }

  private say(pawn: number, text: string, now: number): void {
    if (now - (this.lastBark.get(pawn) ?? -Infinity) < BARK_GAP_MS) return;
    if (this.barks.length >= MAX_BARKS) return;
    this.lastBark.set(pawn, now);
    const root = new Container();
    const label = new BitmapText({ text, style: BUBBLE_TEXT });
    label.scale.set(0.5);
    const w = label.width + 12;
    const h = label.height + 7;
    const g = new Graphics();
    g.roundRect(-w / 2, -h, w, h, 4).fill({ color: 0xf3ead7, alpha: 0.96 }).stroke({ width: 1, color: 0x6f5729 });
    // The tail, pointing down at the speaker.
    g.poly([-4, -0.5, 4, -0.5, 0, 5]).fill({ color: 0xf3ead7, alpha: 0.96 });
    label.position.set(-label.width / 2, -h + 3);
    root.addChild(g, label);
    this.view.addChild(root);
    this.barks.push({ pawn, root, born: now });
  }

  /** A new stack where a tree just fell or rock was just mined: show what it gave. */
  private maybeGain(m: Mirror, it: Item, now: number): void {
    const near = this.cleared.some((c) => Math.hypot((c.cell % m.w) - it.x, Math.floor(c.cell / m.w) - it.y) <= HARVEST_RADIUS);
    if (!near) return;
    this.float(`+${it.count} ${ITEMS[it.def]?.label ?? it.def}`, (it.x + 0.5) * TILE, it.y * TILE, 0xffd9a0, now);
  }

  /** Words rising from a point on the map, in world units. */
  float(text: string, x: number, y: number, tint: number, now: number): void {
    const t = new BitmapText({ text, style: GAIN_TEXT });
    t.scale.set(0.5);
    t.tint = tint;
    t.position.set(x - t.width / 2, y);
    this.view.addChild(t);
    this.gains.push({ root: t, born: now, y0: y });
  }

  private animate(now: number, pawnPos: (id: number) => { x: number; y: number } | null): void {
    this.barks = this.barks.filter((b) => {
      const age = now - b.born;
      const at = pawnPos(b.pawn);
      if (age > BARK_MS || !at) {
        b.root.destroy({ children: true });
        return false;
      }
      b.root.position.set(at.x, at.y - TILE * 0.75);
      b.root.alpha = age > BARK_MS - 400 ? (BARK_MS - age) / 400 : Math.min(1, age / 120);
      return true;
    });
    this.gains = this.gains.filter((g) => {
      const age = now - g.born;
      if (age > GAIN_MS) {
        g.root.destroy();
        return false;
      }
      const k = age / GAIN_MS;
      g.root.y = g.y0 - 22 * (1 - (1 - k) * (1 - k));
      g.root.alpha = k > 0.6 ? (1 - k) / 0.4 : 1;
      return true;
    });
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

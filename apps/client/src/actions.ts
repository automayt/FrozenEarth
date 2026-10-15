import type { Pawn } from '@fe/sim';
import { command, send } from './net';
import { store } from './store';

export function myPlayer() {
  return store.players.find((p) => p.id === store.me?.playerId);
}

export function setSpeed(speed: number): void {
  send({ t: 'speed', speed });
}

let lastSpeed = 1;

export function togglePause(): void {
  const me = myPlayer();
  if (!me) return;
  if (me.speed === 0) setSpeed(lastSpeed || 1);
  else {
    lastSpeed = me.speed;
    setSpeed(0);
  }
}

/** Own pawns currently selected (that still exist). */
export function mySquad(): Pawn[] {
  const out: Pawn[] = [];
  for (const id of store.squad) {
    const p = store.mirror.get<Pawn>(id);
    if (p && p.kind === 'pawn' && p.faction === store.me?.faction && !p.prisoner) out.push(p);
  }
  return out;
}

/** All own colonists (not prisoners). */
export function myPawnsAll(): Pawn[] {
  const out: Pawn[] = [];
  for (const e of store.mirror.entities.values()) if (e.kind === 'pawn' && e.faction === store.me?.faction && !e.prisoner) out.push(e);
  return out;
}

/** Who should act on an order about something at (x, y): the selected colonists, else everyone able, nearest first. */
export function helpers(x: number, y: number): Pawn[] {
  const squad = mySquad();
  return (squad.length ? squad : myPawnsAll())
    .filter((p) => !p.downed)
    .sort((a, b) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) - Math.max(Math.abs(b.x - x), Math.abs(b.y - y)));
}

/** Draft the selected colonists, or undraft them if they all already are. With nothing selected, everyone. */
export function toggleDraft(): void {
  const squad = mySquad();
  const who = (squad.length ? squad : myPawnsAll()).filter((p) => !p.downed);
  if (!who.length) return;
  const on = !who.every((p) => p.drafted);
  command({ c: 'draft', pawns: who.map((p) => p.id), on });
  if (!squad.length) store.set({ squad: who.map((p) => p.id), selected: who[0].id });
}

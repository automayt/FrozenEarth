import { send } from './net';
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

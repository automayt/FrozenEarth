import { decode, encode, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@fe/protocol';
import type { Command } from '@fe/sim';
import { store } from './store';

const tokenKey = (name: string) => `fe.token.${name.trim().toLowerCase()}`;
const NAME_KEY = 'fe.name';

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the player just won't auto-rejoin.
  }
}

export function savedName(): string {
  return readLocal(NAME_KEY) ?? '';
}

export function hasToken(name: string): boolean {
  return !!readLocal(tokenKey(name));
}

let ws: WebSocket | null = null;
let retry = 0;
let joinArgs: { name: string; password?: string } | null = null;
let pingTimer: number | undefined;

export function connect(name: string, password?: string): void {
  joinArgs = { name, password };
  writeLocal(NAME_KEY, name);
  open();
}

function open(): void {
  store.set({ status: 'connecting', error: '' });
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  let fatal = false;
  sock.onopen = () => {
    retry = 0;
    send({ t: 'hello', v: PROTOCOL_VERSION, name: joinArgs!.name, password: joinArgs!.password, token: readLocal(tokenKey(joinArgs!.name)) ?? undefined });
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => send({ t: 'ping', at: performance.now() }), 3000);
  };
  sock.onmessage = (ev) => {
    const msg = decode<ServerMsg>(ev.data as ArrayBuffer);
    if (msg.t === 'error' && msg.fatal) fatal = true;
    handle(msg);
  };
  sock.onclose = () => {
    clearInterval(pingTimer);
    if (ws !== sock) return;
    ws = null;
    if (fatal) return;
    // Reconnect with backoff; the token brings us back to the same colony.
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    store.set({ status: 'connecting', error: 'Connection lost. Reconnecting…' });
    setTimeout(open, delay);
  };
}

function handle(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome':
      writeLocal(tokenKey(joinArgs!.name), msg.token);
      store.mirror.applySnapshot(msg.snap);
      store.setServerTick(msg.snap.tick);
      store.set({ status: 'playing', error: '', me: { playerId: msg.playerId, faction: msg.faction }, sites: msg.sites ?? [] });
      if (!store.focus) {
        const f = store.mirror.factions.get(msg.faction);
        const first = msg.sites?.[0];
        if (f) store.set({ focus: { ...f.home } });
        else if (first) store.set({ focus: { x: first.x, y: first.y }, settlePick: { x: first.x, y: first.y } });
      }
      return;
    case 'settled': {
      store.set({ me: { playerId: store.me!.playerId, faction: msg.faction }, sites: [], settlePick: null });
      // The faction arrives in the next delta; jump home once it does.
      const jump = () => {
        const f = store.mirror.factions.get(msg.faction);
        if (f) store.set({ focus: { ...f.home } });
        else setTimeout(jump, 100);
      };
      jump();
      return;
    }
    case 'delta':
      store.mirror.applyDelta(msg.d);
      store.setServerTick(msg.d.tick);
      store.time = msg.time;
      store.emit();
      return;
    case 'players':
      store.set({ players: msg.players, time: msg.time });
      return;
    case 'chat':
      store.chat.push({ from: msg.from, color: msg.color, text: msg.text, at: msg.at });
      if (store.chat.length > 100) store.chat.shift();
      store.emit();
      return;
    case 'error':
      if (msg.fatal) store.set({ status: 'error', error: msg.msg });
      else {
        store.chat.push({ from: '', color: 0xe07a5a, text: msg.msg, at: Date.now() });
        store.emit();
      }
      return;
    case 'pong':
      store.set({ ping: Math.round(performance.now() - msg.at) });
      return;
  }
}

export function send(msg: ClientMsg): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(encode(msg));
}

export function command(cmd: Command): void {
  send({ t: 'cmd', cmd });
}

export function forgetIdentity(name: string): void {
  try {
    localStorage.removeItem(tokenKey(name));
  } catch {
    // ignore
  }
}

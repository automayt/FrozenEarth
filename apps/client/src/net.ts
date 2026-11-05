import { decode, encode, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@fe/protocol';
import type { Command } from '@fe/sim';
import { store } from './store';
import { sound } from './audio';

const tokenKey = (name: string) => `fe.token.${name.trim().toLowerCase()}`;
const NAME_KEY = 'fe.name';
const FAREWELL_KEY = 'fe.farewell';

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
/**
 * The server sends at least the player list every second, so this long without a word means the
 * link died without closing (wifi gone, a sleeping laptop). Browsers can take minutes to notice
 * that on their own; reconnect instead.
 */
const SILENT_MS = 10_000;

/** This browser's rejoin code for a name: paste it on another device to play the same colony. */
export function rejoinCode(name: string): string | null {
  return readLocal(tokenKey(name));
}

/** `code` is a rejoin code from another device; it replaces whatever this browser remembers for the name. */
export function connect(name: string, password?: string, code?: string): void {
  joinArgs = { name, password };
  if (code) writeLocal(tokenKey(name), code);
  open();
}

function open(): void {
  store.set({ status: 'connecting', error: '' });
  // Relative to the page, so the game also works under a proxy prefix (example.com/frozen/ws); wss on https.
  const url = new URL('ws', document.baseURI);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  let fatal = false;
  let heard = performance.now();
  sock.onopen = () => {
    retry = 0;
    heard = performance.now();
    send({ t: 'hello', v: PROTOCOL_VERSION, name: joinArgs!.name, password: joinArgs!.password, token: readLocal(tokenKey(joinArgs!.name)) ?? undefined });
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => {
      if (performance.now() - heard > SILENT_MS) {
        // Give up on this socket without waiting for a close that may never come.
        sock.onclose = null;
        sock.onmessage = null;
        sock.close();
        dropped();
        return;
      }
      send({ t: 'ping', at: performance.now() });
    }, 3000);
  };
  sock.onmessage = (ev) => {
    heard = performance.now();
    const msg = decode<ServerMsg>(ev.data as ArrayBuffer);
    if (msg.t === 'error' && msg.fatal) fatal = true;
    handle(msg);
  };
  const dropped = () => {
    clearInterval(pingTimer);
    if (ws !== sock) return;
    ws = null;
    if (fatal) return;
    // Reconnect with backoff; the token brings us back to the same colony.
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    store.set({ status: 'connecting', error: 'Connection lost. Reconnecting…' });
    setTimeout(open, delay);
  };
  sock.onclose = dropped;
}

function handle(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome':
      writeLocal(tokenKey(joinArgs!.name), msg.token);
      // Only now: a refused name must not replace the colony this browser can already continue.
      writeLocal(NAME_KEY, joinArgs!.name);
      store.mirror.applySnapshot(msg.snap);
      store.restartClock(msg.snap.tick);
      // What happened while we were gone: letters (the mirror only collects them live) and chat.
      if (msg.msgs?.length) store.mirror.messages = msg.msgs.slice();
      if (msg.chat?.length && !store.chat.length) store.chat.push(...msg.chat);
      store.set({ status: 'playing', error: '', me: { playerId: msg.playerId, faction: msg.faction }, sites: msg.sites ?? [], lastSeen: msg.lastSeen ?? null });
      if (document.hidden) send({ t: 'away', away: true });
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
      // A chime for letters that matter to us.
      for (const m of msg.d.msgs) {
        if (m.faction !== 0 && m.faction !== store.me?.faction) continue;
        sound.letter(m);
        // Answers to our own commands (refusals, results) pop up where they can't be missed.
        if (m.reply && m.faction) {
          const w = store.mirror.w;
          store.toast(m.text, m.tone, m.at !== undefined && w ? { x: m.at % w, y: Math.floor(m.at / w) } : undefined);
        }
      }
      if (msg.d.choices?.some((c) => c.faction === store.me?.faction && !store.mirror.choices.some((o) => o.id === c.id))) sound.play('letter');
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
      if (!msg.fatal) store.toast(msg.msg, 'bad');
      // Turned away while in the world (kicked, or playing from somewhere else): a page only starts
      // one renderer, so go back to the title through a fresh page, with the reason.
      else if (store.me) showAfterReload(msg.msg);
      else store.set({ status: 'error', error: msg.msg });
      return;
    case 'pong':
      store.set({ ping: Math.round(performance.now() - msg.at) });
      return;
  }
}

// A background tab tells the server, so its speed vote stops holding other players back.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => send({ t: 'away', away: document.hidden }));

export function send(msg: ClientMsg): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(encode(msg));
}

export function command(cmd: Command): void {
  sound.command(cmd.c);
  send({ t: 'cmd', cmd });
}

function showAfterReload(text: string): void {
  try {
    sessionStorage.setItem(FAREWELL_KEY, text);
  } catch {
    // Storage blocked: the title just won't say why.
  }
  location.reload();
}

/** A reason left by showAfterReload, for the title screen to show. */
function takeFarewell(): void {
  try {
    const text = sessionStorage.getItem(FAREWELL_KEY);
    if (text === null) return;
    sessionStorage.removeItem(FAREWELL_KEY);
    store.set({ status: 'error', error: text });
  } catch {
    // Storage blocked or missing: nothing to show.
  }
}

if (typeof window !== 'undefined') takeFarewell();

/** Back to the title screen. The colony stays in the world; a fresh page drops every trace of it from the client. */
export function leaveWorld(): void {
  const sock = ws;
  ws = null;
  clearInterval(pingTimer);
  sock?.close();
  location.reload();
}

export function forgetIdentity(name: string): void {
  try {
    localStorage.removeItem(tokenKey(name));
  } catch {
    // ignore
  }
}

// The socket lives in this module: hot-swapping it would leave commands going nowhere. Reload instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());

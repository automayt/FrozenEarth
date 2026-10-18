import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { attachSockets, MAX_PAYLOAD } from '../src/edge';

let http: Server;
let port = 0;
const seen: string[] = [];
const sockets: import('ws').WebSocket[] = [];

beforeAll(async () => {
  http = createServer((_req, res) => res.end('ok'));
  attachSockets(
    http,
    (ws, ip) => {
      seen.push(ip);
      sockets.push(ws);
      ws.on('message', (d) => ws.send(d));
    },
    { base: '/frozen', trustProxy: true, allowOrigins: ['https://friends.example'], maxConnections: 4, log: () => {} },
  );
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  port = (http.address() as { port: number }).port;
});
afterAll(() => {
  for (const s of sockets) s.terminate();
  http.close();
});

/** Opens a socket; resolves with 'open' or the HTTP status it was refused with. */
function tryOpen(path: string, headers: Record<string, string> = {}): Promise<{ status: number | 'open'; ws: WebSocket }> {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on('open', () => res({ status: 'open', ws }));
    ws.on('unexpected-response', (_q, r) => res({ status: r.statusCode ?? 0, ws }));
    ws.on('error', () => {});
  });
}

describe('websocket edge', () => {
  it('accepts /ws and the base path, refuses other paths and foreign origins', async () => {
    expect((await tryOpen('/ws')).status).toBe('open');
    expect((await tryOpen('/frozen/ws')).status).toBe('open');
    expect((await tryOpen('/other')).status).toBe(404);
    expect((await tryOpen('/ws', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await tryOpen('/ws', { Origin: 'null' })).status).toBe(403);
    expect((await tryOpen('/ws', { Origin: 'https://friends.example' })).status).toBe('open');
    for (const s of sockets.splice(0)) s.terminate();
  });

  it('matches the origin against Host or a trusted X-Forwarded-Host, and takes the client address from the proxy', async () => {
    seen.length = 0;
    const a = await tryOpen('/ws', { Origin: 'https://game.example', 'X-Forwarded-Host': 'game.example', 'X-Forwarded-For': '1.2.3.4, 198.51.100.7' });
    expect(a.status).toBe('open');
    const b = await tryOpen('/ws', { Origin: 'https://other.example', 'CF-Connecting-IP': '203.0.113.9' });
    expect(b.status).toBe(403);
    const c = await tryOpen('/ws', { 'CF-Connecting-IP': '203.0.113.9' });
    expect(c.status).toBe('open');
    // The last X-Forwarded-For entry is the proxy's own; the first is whatever the client claimed.
    expect(seen).toEqual(['198.51.100.7', '203.0.113.9']);
    for (const s of sockets.splice(0)) s.terminate();
  });

  it('caps connections and drops oversized messages', async () => {
    // Let the sockets closed above finish closing on the server side.
    await new Promise((r) => setTimeout(r, 100));
    const open = await Promise.all([1, 2, 3, 4].map(() => tryOpen('/ws')));
    expect(open.every((o) => o.status === 'open')).toBe(true);
    expect((await tryOpen('/ws')).status).toBe(503);
    const ws = open[0].ws;
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.send(Buffer.alloc(MAX_PAYLOAD + 1));
    expect(await closed).toBe(1009);
    for (const o of open) o.ws.terminate();
  });
});

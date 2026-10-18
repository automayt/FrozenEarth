/**
 * A TCP proxy that makes a link behave like a real one: latency, jitter, and packet loss as TCP
 * shows it to an application (a lost segment holds everything behind it until it's resent, so
 * loss is a stall, never a gap or a reordering). It can also stall the link outright for a few
 * seconds, black-hole it (the connection stays open but nothing arrives, like wifi dropping out),
 * or cut it. It works below WebSocket, so it serves bots and browsers alike:
 *
 *   npx tsx tools/bots/src/lagproxy.ts --listen 8140 --target 8103 --latency 120 --jitter 60 --loss 0.02
 *
 * then point a browser (or the Vite proxy) at port 8140 instead of the server.
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export interface LagProfile {
  /** Round-trip time in ms; each direction gets half. */
  latency: number;
  /** Extra one-way delay, uniformly 0..jitter ms. */
  jitter: number;
  /** Chance a chunk is "lost" and has to be resent: it and everything behind it wait `rto` ms more. */
  loss: number;
  /** Retransmission timeout, ms. */
  rto: number;
}

export const PROFILES: Record<string, LagProfile> = {
  lan: { latency: 2, jitter: 1, loss: 0, rto: 200 },
  good: { latency: 40, jitter: 10, loss: 0, rto: 200 },
  far: { latency: 150, jitter: 40, loss: 0.005, rto: 300 },
  wifi: { latency: 60, jitter: 120, loss: 0.02, rto: 250 },
  bad: { latency: 250, jitter: 200, loss: 0.05, rto: 400 },
};

/** One direction of one connection: chunks go out in order, each no earlier than its delay allows. */
class Pipe {
  private queue: { at: number; data: Buffer }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastAt = 0;
  bytes = 0;

  constructor(
    private out: Socket,
    private proxy: LagProxy,
  ) {}

  push(data: Buffer): void {
    const p = this.proxy.profile;
    const now = Date.now();
    let at = now + p.latency / 2 + Math.random() * p.jitter;
    if (Math.random() < p.loss) at += p.rto;
    // TCP delivers in order: nothing overtakes a chunk that is still on its way.
    at = Math.max(at, this.lastAt, this.proxy.heldUntil);
    this.lastAt = at;
    this.queue.push({ at, data });
    this.schedule();
  }

  schedule(): void {
    if (this.timer || !this.queue.length) return;
    const wait = Math.max(0, Math.max(this.queue[0].at, this.proxy.heldUntil) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    const now = Date.now();
    if (this.proxy.blackholed || now < this.proxy.heldUntil) return this.schedule();
    while (this.queue.length && this.queue[0].at <= now) {
      const { data } = this.queue.shift()!;
      this.bytes += data.length;
      this.proxy.delivered(this, data.length);
      if (!this.out.destroyed) this.out.write(data);
    }
    this.schedule();
  }

  /** Everything held during a black-hole or stall goes out now. */
  release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastAt = 0;
    for (const q of this.queue) q.at = Math.min(q.at, Date.now());
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }
}

export class LagProxy {
  /** Nothing is delivered before this time (a stall). */
  heldUntil = 0;
  /** Nothing is delivered at all until it's lifted, but the connections stay open. */
  blackholed = false;
  private server: Server;
  private conns = new Set<{ a: Socket; b: Socket; up: Pipe; down: Pipe }>();
  /** Bytes delivered server -> client and client -> server over the proxy's lifetime. */
  down = 0;
  up = 0;
  /** Connections one end closed while the link was black-holed: the other end hears of it once it's back. */
  private pendingEnds: (() => void)[] = [];

  constructor(
    private targetPort: number,
    public profile: LagProfile,
    private targetHost = '127.0.0.1',
  ) {
    this.server = createServer((client) => this.accept(client));
  }

  listen(port = 0): Promise<number> {
    return new Promise((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(port, '127.0.0.1', () => res((this.server.address() as { port: number }).port));
    });
  }

  private accept(client: Socket): void {
    client.setNoDelay(true);
    const upstream = connect(this.targetPort, this.targetHost);
    upstream.setNoDelay(true);
    const c = { a: client, b: upstream, up: new Pipe(upstream, this), down: new Pipe(client, this) };
    this.conns.add(c);
    client.on('data', (d) => c.up.push(d));
    upstream.on('data', (d) => c.down.push(d));
    this.dirOf.set(c.up, 'up');
    this.dirOf.set(c.down, 'down');
    const end = () => {
      if (!this.conns.has(c)) return;
      // A dead link carries no FIN either: the other side keeps waiting.
      if (this.blackholed) {
        this.pendingEnds.push(end);
        return;
      }
      this.conns.delete(c);
      c.up.stop();
      c.down.stop();
      client.destroy();
      upstream.destroy();
    };
    client.on('close', end);
    upstream.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
  }

  private dirOf = new WeakMap<Pipe, 'up' | 'down'>();

  delivered(pipe: Pipe, n: number): void {
    if (this.dirOf.get(pipe) === 'up') this.up += n;
    else this.down += n;
  }

  /** Hold all traffic both ways for `ms`, then let it through in order (a long retransmit, a busy router). */
  stall(ms: number): void {
    this.heldUntil = Math.max(this.heldUntil, Date.now() + ms);
  }

  /** Stop delivering anything, without closing: the link is dead but neither end has been told. */
  blackhole(on: boolean): void {
    this.blackholed = on;
    if (on) return;
    for (const c of this.conns) {
      c.up.release();
      c.down.release();
    }
    for (const end of this.pendingEnds.splice(0)) end();
  }

  /** Cut every connection now, as a router reboot would. */
  cut(): void {
    this.blackholed = false;
    for (const c of [...this.conns]) {
      c.a.destroy();
      c.b.destroy();
    }
  }

  close(): Promise<void> {
    this.cut();
    return new Promise((res) => this.server.close(() => res()));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values: a } = parseArgs({
    options: {
      listen: { type: 'string', default: '8140' },
      target: { type: 'string', default: '8090' },
      host: { type: 'string', default: '127.0.0.1' },
      profile: { type: 'string' },
      latency: { type: 'string' },
      jitter: { type: 'string' },
      loss: { type: 'string' },
      rto: { type: 'string' },
    },
  });
  const base = PROFILES[a.profile ?? 'wifi'] ?? PROFILES.wifi;
  const profile: LagProfile = {
    latency: a.latency !== undefined ? Number(a.latency) : base.latency,
    jitter: a.jitter !== undefined ? Number(a.jitter) : base.jitter,
    loss: a.loss !== undefined ? Number(a.loss) : base.loss,
    rto: a.rto !== undefined ? Number(a.rto) : base.rto,
  };
  const proxy = new LagProxy(Number(a.target), profile, a.host);
  const port = await proxy.listen(Number(a.listen));
  console.log(`lag proxy :${port} -> ${a.host}:${a.target}  ${JSON.stringify(profile)}`);
  console.log('keys: s = stall 3 s, b = toggle black-hole, c = cut connections, q = quit');
  process.stdin.setRawMode?.(true);
  process.stdin.on('data', (k) => {
    const key = k.toString();
    if (key === 's') {
      proxy.stall(3000);
      console.log('stalled 3 s');
    } else if (key === 'b') {
      proxy.blackhole(!proxy.blackholed);
      console.log(`black-hole ${proxy.blackholed ? 'on' : 'off'}`);
    } else if (key === 'c') {
      proxy.cut();
      console.log('cut');
    } else if (key === 'q' || key === '\u0003') void proxy.close().then(() => process.exit(0));
  });
}

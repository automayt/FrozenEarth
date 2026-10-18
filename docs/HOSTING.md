# Hosting a FrozenEarth server

One person (the host) runs the server. It serves the game page and the websocket on **one port**, so friends only need one address. Everyone plays in the browser.

## Quick start

Requires Node 22+ and git.

```bash
git clone <repo> frozen-earth && cd frozen-earth
npm ci
npm run build
FE_PASSWORD='pick-something' npm start -- --world friends
```

On Windows PowerShell: `$env:FE_PASSWORD='pick-something'; npm start -- --world friends`.

The server prints its addresses:

```
FrozenEarth server on http://localhost:8090/  (world "friends", password protected)
  on your network: http://192.168.1.20:8090/
  host key for /claim: in saves/friends/host-key.txt
```

Open the address, pick a name and enter the password. The first player to join a new world is a host. Stop the server with **Ctrl+C**: it saves first.

Prefer `FE_PASSWORD` to `--password`, because command-line arguments are visible to other users of the machine in the process list. The password is stored with the world as a salted hash, so after the first start you can leave it out. `--password` or `FE_PASSWORD` replaces the stored password, and `--clear-password` removes it.

## Where to run it

### On your LAN

The default works: the server listens on every interface. Friends on the same network open `http://<your-LAN-ip>:8090/`. If they can't connect, allow Node (or the port) through the firewall. Windows asks the first time the server starts; accept for **private** networks.

### Tailscale (recommended for friends elsewhere)

Install Tailscale on your machine and on each friend's machine, and share the machine with them (or invite them to your tailnet). They then open `http://<your-machine>.<tailnet>.ts.net:8090/` or `http://100.x.y.z:8090/`. Nothing is exposed to the internet.

For HTTPS on the tailnet: run `tailscale serve --bg 8090` and have friends use `https://<your-machine>.<tailnet>.ts.net/`. The game switches to `wss://` on HTTPS pages automatically. With `tailscale serve`, start the server with `--host 127.0.0.1 --trust-proxy` so only the proxy can reach it and the server sees real client addresses (it uses them to rate-limit wrong passwords).

`tailscale funnel` makes the server public on the internet. If you use it, set a password.

### Cloudflare Tunnel (cloudflared)

This gives a public `https://` address without opening ports on your router.

```bash
cloudflared tunnel --url http://localhost:8090            # quick try: prints a random trycloudflare.com URL
# or, with a named tunnel and your own domain, in config.yml:
#   ingress:
#     - hostname: frozen.example.com
#       service: http://localhost:8090
#     - service: http_status:404
```

Run the server with `--host 127.0.0.1 --trust-proxy`. `--host` stops anyone bypassing the tunnel. `--trust-proxy` makes the server read the client address from `CF-Connecting-IP`. Websockets work through Cloudflare tunnels without extra settings. Always use a password on a public address.

### A VPS (or any machine with a public IP)

Run the server behind a reverse proxy that terminates TLS (Caddy is the least work), and bind the server to localhost:

```bash
npm start -- --world friends --host 127.0.0.1 --trust-proxy
```

Caddy (`/etc/caddy/Caddyfile`). Caddy gets the certificate and proxies websockets by itself:

```
frozen.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;                       # needed: the server checks the page's origin against it
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
}
```

To keep it running and restart it after a crash, use a systemd unit (`/etc/systemd/system/frozen-earth.service`):

```ini
[Unit]
Description=FrozenEarth server
After=network.target

[Service]
WorkingDirectory=/home/fe/frozen-earth
ExecStart=/usr/bin/npm start -- --world friends --host 127.0.0.1 --trust-proxy
Environment=FE_PASSWORD=pick-something
User=fe
Restart=on-failure
# SIGTERM: the server saves, then exits.
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

The server answers `GET /healthz` with `{"ok":true,"day":…,"online":…,"halted":false}` for uptime checks.

### Under a path (example.com/frozen/)

The client uses relative URLs, so a proxy can serve it under a prefix. There are two cases:

- The proxy **strips** the prefix (for example, nginx `location /frozen/ { proxy_pass http://127.0.0.1:8090/; … }`). Nothing else is needed.
- The proxy **keeps** the prefix. Start the server with `--base /frozen` (`FE_BASE=/frozen`). In Git Bash, write `--base frozen`, because Git Bash rewrites arguments that start with `/`.

Players must open the address with the trailing slash (`/frozen/`); `/frozen` redirects to it. The websocket is at `/frozen/ws`.

## Server options

| Option | Env | Default | What it does |
| --- | --- | --- | --- |
| `--world <name>` | `FE_WORLD` | `default` | World to load or create, in `saves/<name>/` |
| `--port <n>` | `FE_PORT` | `8090` | One port for the page and the websocket |
| `--host <addr>` | `FE_HOST` | all interfaces | `127.0.0.1` behind a proxy or tunnel |
| `--password <pw>` | `FE_PASSWORD` | stored one | Sets the join password (stored hashed) |
| `--clear-password` | | | Removes the stored password |
| `--base <path>` | `FE_BASE` | none | Path prefix when a proxy keeps one |
| `--trust-proxy` | `FE_TRUST_PROXY=1` | off | Read client addresses from `CF-Connecting-IP` / `X-Forwarded-For`. Only use it behind a proxy, because clients can forge these headers |
| `--allow-origin <urls>` | `FE_ALLOW_ORIGIN` | none | Extra page origins allowed to open the websocket (comma-separated) |
| `--max-connections <n>` | `FE_MAX_CONNECTIONS` | `32` | Open sockets at once (also at most 12 from one address) |
| `--host-key <key>` | `FE_HOST_KEY` | generated | Host key for `/claim`, instead of `host-key.txt` |
| `--keep-backups <n>` | `FE_KEEP_BACKUPS` | `48` | Automatic backups kept of each kind |
| `--saves <dir>` | `FE_SAVES` | `saves` | Where worlds live |
| `--seed`, `--size`, `--frost-start`, `--frost-pace` | | | New worlds only |
| `--backups` | | | List this world's backups and exit |
| `--restore <name>` | | | Restore a backup, then start |
| `--no-console` | | | Don't read host commands from the terminal |

## Host commands

Type them in the server's terminal (without the `/`), or in the in-game chat with a leading `/`. Lines that start with `/` are never shown to other players. Everyone can use `/help`, `/who` and `/claim`. The other commands need host rights.

| Command | |
| --- | --- |
| `who` | Players, online or not, ping, colonists, hosts. The terminal also shows addresses |
| `claim <key>` | Become a host using the key in `saves/<world>/host-key.txt` (works from any account) |
| `op <name>` / `deop <name>` | Give or take host rights |
| `kick <name>` | Disconnect someone (they can come back) |
| `ban <name>` / `unban <name>` | Keep someone out. Their colony stays in the world. Someone who knows the password could rejoin under a new name, so change the password too |
| `password <new>` / `password off` | Change or remove the join password. Players already in keep their colonies |
| `release <name>` | Lets a player who lost their browser data (new PC, cleared storage) rejoin their colony: for 15 minutes, joining with that name and the server password takes the colony over, and their old browser stops working |
| `save`, `backup` | Save now, or copy the world into `backups/` |
| `backups`, `restore <name>` | List backups, or load one into the running world (the current world is backed up first; players keep their accounts) |
| `say <text>` | Message everyone as the host |
| `resume` | Restart the game after it stopped itself following repeated server errors |
| `quit` | (terminal only) Save and stop |

Hosts also get the in-game Events panel for triggering events.

## Saves, backups and crashes

Everything lives in `saves/<world>/`:

| File | |
| --- | --- |
| `world.bin` | The world, players and their tokens, and the password hash. Keep it private: the tokens in it are logins |
| `world.bak` | The save before the last one |
| `host-key.txt` | The host key for `/claim` |
| `backups/` | `…-auto.bin` every hour while running, `…-startup.bin` at every start (made before the server touches the world, so an upgrade that goes wrong can be undone), plus `manual` and `prerestore` ones that are never pruned |
| `crashes/` | Crash reports (see below) |

The world saves every minute, when a colony is founded, when the last player leaves, and on Ctrl+C, SIGTERM, SIGHUP, or when the console window is closed. Saves are atomic: the new file is written and flushed completely before it replaces the old one. A power cut or `kill -9` therefore costs at most the last minute, never the world. If `world.bin` is ever damaged, the server falls back to the newest whole file (`world.bin.tmp`, `world.bak`, then backups), moves the damaged one aside as `world.bin.corrupt-…`, and logs a warning. If no file can be read, it refuses to start rather than generate a new world over the old one.

**Restore a backup:** `npm start -- --world friends --backups` lists them. Then either `npm start -- --world friends --restore 2026-10-18_1400` (it matches on part of the name), or `restore <name>` in a running server. Copying a backup over `world.bin` while the server is stopped also works.

**Rename a world:** stop the server, rename the folder `saves/old` to `saves/new`, and start with `--world new`.

**Move to another machine:** copy the `saves/<world>/` folder.

**When the game itself hits a bug** (an exception inside a tick), the server does not go down. It writes `crashes/crash-<time>-t<tick>.txt` (the stack) and a `.bin`, rolls the world back to its last restore point (taken every 15 seconds of real time), tells everyone in chat, and carries on. If that happens 3 times in 10 minutes, it stops the game, saves, and waits: players stay connected and can chat, and a host can `/resume` or restart the server. The `.bin` holds the restore point plus every command since, so a developer can replay the crash exactly: `npm run replay -- saves/friends/crashes/crash-….bin`. Please send them in with bug reports.

## Upgrading

```bash
# Ctrl+C the server (it saves), then:
git pull
npm ci
npm run build
npm start -- --world friends
```

Older worlds are migrated when they load. The start-up backup is made before that, so if a new version mishandles your world, go back with `git checkout <old version>`, `npm ci`, `npm run build`, and `--restore <name>-startup`. A world saved by a newer server is refused by an older one, rather than replaced with an old backup. After an upgrade, players must refresh the page. The game tells them if their page is out of date.

## Security notes

- **Password.** Use one for anything reachable from the internet. Wrong passwords are limited to 5 per address per 10 minutes and 40 per 10 minutes for the whole server (the same limits apply to `/claim`). After a correct join, the browser keeps a random token instead of the password, so returning players don't type it again. Changing the password does not lock out people already in; use `ban` for that.
- **Tokens.** These are the per-player logins. Clearing site data loses yours; the host can `release` your name. They are never put in URLs or logs.
- **Origin check.** Only pages served by this server (same host, or a localhost dev server) can open the websocket, so another website can't make a visitor's browser join or flood your server. If you serve the page from somewhere else, list that origin with `--allow-origin`.
- **Limits.** Messages are capped at 64 KB. Each player gets 40 commands a second and 2 chat lines a second (bursts up to 6). A socket sending thousands of messages a second is dropped. A connection that doesn't log in within 15 s is closed. There are at most 32 sockets, and 12 per address.
- **Exposure.** The server serves only the built client and `/healthz`, and never lists files. Bind it to `127.0.0.1` behind a proxy or tunnel, so the only way in is through the proxy.
- **Admin.** The first player of a new world is a host. The host key in `host-key.txt` gives host rights to whoever can read the server's files, from any account. Don't share it, and regenerate it by deleting the file and restarting.

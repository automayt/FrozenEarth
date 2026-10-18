import { daysUntilFrost, frostLevel, frostRadius, MIN_COLONY_GAP } from '@fe/sim';
import { send } from '../net';
import { store, useStore } from '../store';
import { hex } from './util';

/** The nearest player colony to a spot, and how far it is. */
function nearestColony(x: number, y: number): { name: string; owner: string; color: number; d: number } | null {
  let best: { name: string; owner: string; color: number; d: number } | null = null;
  for (const f of store.mirror.factions.values()) {
    if (!f.isPlayer) continue;
    const d = Math.hypot(f.home.x - x, f.home.y - y);
    if (!best || d < best.d) best = { name: f.name, owner: store.players.find((p) => p.faction === f.id)?.name ?? f.name, color: f.color, d };
  }
  return best;
}

function frostDays(x: number, y: number): number {
  const m = store.mirror;
  return daysUntilFrost(x, y, m.w, m.h, store.estTick(), m.frost, 40);
}

const daysText = (d: number) => (d === 0 ? 'frozen' : d === Infinity ? 'frost 40+ days off' : `frost in ${d} day${d === 1 ? '' : 's'}`);

/** What the server would refuse about a spot that the client can tell already (the server has the last word). */
function pickProblem(x: number, y: number): string | null {
  const m = store.mirror;
  if (frostLevel(x, y, m.w, m.h, frostRadius(store.estTick(), m.frost)) > 0) return 'That land has already frozen over.';
  const n = nearestColony(x, y);
  if (n && n.d < MIN_COLONY_GAP) return `Too close to ${n.name}: colonies keep ${MIN_COLONY_GAP} cells apart.`;
  return null;
}

/** Shown to a new player before their colony exists. */
export function SettlePanel() {
  const s = useStore();
  const pick = s.settlePick;
  const friends = s.players.filter((p) => p.faction && s.mirror.factions.has(p.faction));
  const problem = pick ? pickProblem(pick.x, pick.y) : null;
  const pickDays = pick ? frostDays(pick.x, pick.y) : 0;
  const pickNear = pick ? nearestColony(pick.x, pick.y) : null;
  return (
    <div className="panel settle">
      <h3>Choose where to settle</h3>
      <p className="muted">
        The <b>outer band</b> is gentle now but freezes first. The <b>middle lands</b> and the <b>center</b> are harsher, but winter
        reaches them last. Click anywhere on the map to pick a spot. Other colonies need room around them (shaded circles).
      </p>
      <p className="muted small">
        The map at the top right shows the frost line closing in and the settlements: <span className="good">green</span> trade gladly, <span style={{ color: 'var(--amber)' }}>amber</span> are wary, <span className="bad">red</span> attack anyone who comes close.
      </p>
      {friends.length > 0 && (
        <div className="settle-friends">
          <span className="muted small">Settle near a friend: look around</span>
          {friends.map((p) => {
            const f = s.mirror.factions.get(p.faction)!;
            return (
              <button key={p.id} className="link" onClick={() => store.set({ focus: { x: f.home.x, y: f.home.y } })} title={`Jump to ${f.name}, then click a spot outside their circle`}>
                <i style={{ background: hex(p.color) }} /> {p.name}
              </button>
            );
          })}
        </div>
      )}
      <div className="sites">
        {s.sites.map((site, i) => {
          const near = nearestColony(site.x, site.y);
          const taken = !!near && near.d < MIN_COLONY_GAP;
          const days = frostDays(site.x, site.y);
          return (
            <button
              key={i}
              className={`${pick && pick.x === site.x && pick.y === site.y ? 'on' : ''} ${taken ? 'taken' : ''}`}
              disabled={taken}
              title={taken ? `${near!.name} settled here first` : `${site.region}, ${daysText(days)}${near ? `, ${Math.round(near.d)} cells from ${near.name}` : ''}`}
              onClick={() => store.set({ settlePick: { x: site.x, y: site.y }, focus: { x: site.x, y: site.y } })}
            >
              Site {i + 1}
              <small>{taken ? `taken by ${near!.owner}` : site.region}</small>
              {!taken && <small className={days <= 5 ? 'bad' : ''}>{days === Infinity ? 'frost 40d+' : `frost ${days}d`}</small>}
              {!taken && near && <small>{near.owner} {Math.round(near.d)} away</small>}
            </button>
          );
        })}
      </div>
      {pick && (
        <p className={`small ${problem ? 'bad' : 'muted'}`}>
          {problem ?? `${pick.x}, ${pick.y}: ${daysText(pickDays)}${pickNear ? `, ${Math.round(pickNear.d)} cells from ${pickNear.name}` : ''}.`}
        </p>
      )}
      <div className="settle-actions">
        <button className="primary" disabled={!pick || !!problem} onClick={() => pick && send({ t: 'settle', x: pick.x, y: pick.y })}>
          {pick ? `Settle at ${pick.x}, ${pick.y}` : 'Pick a spot'}
        </button>
        <button onClick={() => send({ t: 'settle' })} title="One of the good spots, picked at random">
          Let fate decide
        </button>
      </div>
    </div>
  );
}

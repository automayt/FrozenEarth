import { ITEMS } from '@fe/defs';
import { dispositionOf, FRIENDLY_AT, goodwillOf, GOODWILL, GUARD_REACH, HOSTILE_AT, priceFactor, requestText, TICKS_PER_DAY, TRADE_RANGE, type Faction } from '@fe/sim';
import { DISPOSITION_COLOR } from '../render/renderer';
import { store } from '../store';
import { traderNear } from './trade';
import { direction } from './risk';
import { hex } from './util';

/** Where -100..100 sits along a 0..100% track. */
const at = (g: number) => `${(g + 100) / 2}%`;

/** Goodwill from -100 to 100, with the hostile and friendly lines marked. */
export function GoodwillMeter({ f }: { f: Faction }) {
  const me = store.me?.faction ?? 0;
  const st = f.settlement!;
  const g = goodwillOf(st, me);
  const mood = dispositionOf(st, me);
  return (
    <div className="goodwill" title={`Goodwill ${g}. At ${HOSTILE_AT} or below they turn hostile; at ${FRIENDLY_AT} or above they are friends and trade cheaper.`}>
      <div className="gw-track" role="meter" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={g} aria-label={`Goodwill ${g}, ${mood}`}>
        <div className="gw-zone hostile" style={{ left: 0, width: at(HOSTILE_AT) }} />
        <div className="gw-zone friendly" style={{ left: at(FRIENDLY_AT), right: 0 }} />
        <div className="gw-mark" style={{ left: at(g), background: hex(DISPOSITION_COLOR[mood]) }} />
      </div>
      <div className="gw-scale muted">
        <span>hostile ≤ {HOSTILE_AT}</span>
        <span>wary</span>
        <span>friendly ≥ {FRIENDLY_AT}</span>
      </div>
    </div>
  );
}

/** What moves goodwill, from the sim's own numbers. */
export function GoodwillRules() {
  return (
    <details className="gw-rules">
      <summary>What changes their goodwill?</summary>
      <ul>
        <li className="good">
          Gifts: +1 per {GOODWILL.giftValue} worth given beyond a fair price, up to +{GOODWILL.giftMax} a trade
        </li>
        <li className="good">Bringing what they asked for: +{GOODWILL.keptPromise}</li>
        <li className="good">Any fair trade: +{GOODWILL.fairTrade}</li>
        <li className="bad">Caught stealing: {GOODWILL.caughtStealing}</li>
        <li className="bad">
          Attacking their people: {GOODWILL.attackMiss} a miss, {GOODWILL.attackHit} a wound
        </li>
        <li className="bad">A promise you didn't keep: {GOODWILL.brokenPromise}</li>
      </ul>
    </details>
  );
}

/** Everything about a settlement at a glance: mood, goodwill, prices, what they want and have, where it is. */
export function SettlementCard({ f, trade = true }: { f: Faction; trade?: boolean }) {
  const m = store.mirror;
  const me = store.me?.faction ?? 0;
  const st = f.settlement!;
  if (st.state === 'fallen') {
    return (
      <div className="settlement-card">
        <p className="muted small">Abandoned. Whatever is left in its stores belongs to nobody: haul it freely.</p>
      </div>
    );
  }
  const mood = dispositionOf(st, me);
  const factor = priceFactor(st, me);
  let people = 0;
  for (const e of m.entities.values()) if (e.kind === 'pawn' && e.faction === f.id && !e.prisoner) people++;
  const home = m.factions.get(me)?.home;
  const dist = home ? Math.round(Math.hypot(f.home.x - home.x, f.home.y - home.y)) : 0;
  const trader = traderNear(m, me, f.home);
  const met = st.met.includes(me);
  const requests = (st.requests ?? []).filter((r) => r.faction === me);
  // Their biggest stocks, by value.
  const stock = new Map<string, number>();
  for (const e of m.entities.values()) {
    if (e.kind !== 'item') continue;
    const z = m.zones.get(m.zoneAt[e.y * m.w + e.x]);
    if (z?.faction === f.id && z.kind === 'stockpile') stock.set(e.def, (stock.get(e.def) ?? 0) + e.count);
  }
  const top = [...stock.entries()].sort((a, b) => (ITEMS[b[0]]?.marketValue ?? 0) * b[1] - (ITEMS[a[0]]?.marketValue ?? 0) * a[1]).slice(0, 5);
  return (
    <div className="settlement-card">
      <div className="sc-head">
        <span className={`chip mood ${mood}`} style={{ color: hex(DISPOSITION_COLOR[mood]), borderColor: hex(DISPOSITION_COLOR[mood]) }}>
          {mood[0].toUpperCase() + mood.slice(1)}
        </span>
        <span className="muted small">
          {people} {people === 1 ? 'person' : 'people'}
          {st.state === 'leaving' ? ' · on the move, fleeing the frost' : ''}
          {home && dist > 0 ? ` · ${dist} cells ${direction(home, f.home)} of your colony` : ''}
        </span>
      </div>
      <GoodwillMeter f={f} />
      {mood === 'hostile' ? (
        <p className="bad small">Enemies: they won't trade, and attack your colonists within about {st.radius + GUARD_REACH} cells of their town. Only a gift might change their minds, and your envoy has to survive getting there.</p>
      ) : (
        <p className="small">
          Their goods cost <b>×{factor.toFixed(2)}</b> market value; they pay full value for yours.{' '}
          <span className="muted">More goodwill, lower prices (×1.00 at 100).</span>
        </p>
      )}
      <div className="sc-row">
        <span className="muted small">Wants</span>
        <span className="small">
          {requests.length
            ? requests.map((r) => {
                const days = Math.max(0, (r.until - store.estTick()) / TICKS_PER_DAY);
                return (
                  <span key={r.id} className="sc-want">
                    <b>{requestText(r.item, r.count)}</b> within {days >= 1 ? `${Math.ceil(days)}d` : `${Math.max(1, Math.round(days * 24))}h`}, for {r.reward === 'recruit' ? 'a new colonist' : requestText(r.reward[0], r.reward[1])}
                  </span>
                );
              })
            : met
              ? mood === 'hostile'
                ? 'Nothing from enemies.'
                : 'Nothing asked of you yet. Towns that know you send letters when they need help.'
              : `You haven't met yet: bring a colonist within ${st.radius + 10} cells.`}
        </span>
      </div>
      {top.length > 0 && (
        <div className="sc-row">
          <span className="muted small">Has</span>
          <span className="small">{top.map(([d, n]) => `${n} ${ITEMS[d]?.label.toLowerCase() ?? d}`).join(', ')}</span>
        </div>
      )}
      <div className="sc-row">
        <span className="muted small">Trade</span>
        <span className="small">{trader ? <span className="good">{trader} is close enough to trade</span> : `A colonist must be within ${TRADE_RANGE} cells`}</span>
      </div>
      <GoodwillRules />
      <div className="sc-actions">
        {trade && <button onClick={() => store.openTrade(f.id)}>Trade…</button>}
        <button className="link" onClick={() => store.set({ focus: { x: f.home.x, y: f.home.y } })}>
          Show on map
        </button>
      </div>
    </div>
  );
}

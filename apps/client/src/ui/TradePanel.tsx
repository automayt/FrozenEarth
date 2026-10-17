import { useEffect, useState } from 'react';
import { ITEMS } from '@fe/defs';
import { dispositionOf, goodwillOf, lineValue, priceFactor, requestText, TICKS_PER_DAY, TRADE_RANGE, type Faction, type Item, type Pawn } from '@fe/sim';
import { DISPOSITION_COLOR } from '../render/renderer';
import { command } from '../net';
import { store, useStore } from '../store';
import { helpers } from '../actions';
import { hex } from './util';
import { settlementDeal, traderNear as traderAt } from './trade';
import { GoodwillMeter, GoodwillRules } from './SettlementCard';

type Line = { item: string; count: number };

/** What a colony has in its stockpiles. Everyone can see the whole map, so this is public. */
function stockOf(faction: number): Map<string, number> {
  const m = store.mirror;
  const out = new Map<string, number>();
  for (const e of m.entities.values()) {
    if (e.kind !== 'item') continue;
    const z = m.zoneAt[e.y * m.w + e.x];
    if (z && m.zones.get(z)?.faction === faction && m.zones.get(z)?.kind === 'stockpile') out.set((e as Item).def, (out.get((e as Item).def) ?? 0) + (e as Item).count);
  }
  return out;
}

const worth = (v: number) => (v >= 10 ? Math.round(v).toString() : v.toFixed(1));

function LineEditor({ title, lines, setLines, stock, empty, factor }: { title: string; lines: Line[]; setLines: (l: Line[]) => void; stock: Map<string, number>; empty: string; factor: number }) {
  const options = [...stock.entries()].sort((a, b) => ITEMS[a[0]].label.localeCompare(ITEMS[b[0]].label));
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  // Offer the next item not already on the list.
  const fresh = options.find(([d]) => !lines.some((l) => l.item === d)) ?? options[0];
  return (
    <div className="trade-side">
      <h4>{title}</h4>
      {lines.map((l, i) => {
        const have = stock.get(l.item) ?? 0;
        const over = l.count > have;
        return (
          <div key={i} className="trade-line">
            <select value={l.item} aria-label="Item" onChange={(e) => set(i, { item: e.target.value, count: Math.min(l.count, stock.get(e.target.value) ?? 1) })}>
              {options.map(([d, n]) => (
                <option key={d} value={d}>
                  {ITEMS[d].label} ({n})
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={have}
              value={l.count}
              aria-label="Count"
              className={over ? 'over' : ''}
              title={over ? `Only ${have} in stock` : undefined}
              onChange={(e) => set(i, { count: Math.max(1, Math.min(999, Math.round(Number(e.target.value) || 1))) })}
            />
            <button onClick={() => set(i, { count: Math.max(1, have) })} title={`All ${have}`} disabled={l.count === have}>
              Max
            </button>
            <button onClick={() => setLines(lines.filter((_, k) => k !== i))} title="Remove" aria-label="Remove line">
              ×
            </button>
            <small className="line-value" title="Market value of this line">
              {worth((ITEMS[l.item]?.marketValue ?? 0) * l.count * factor)}
            </small>
          </div>
        );
      })}
      {lines.length < 4 && fresh && <button onClick={() => setLines([...lines, { item: fresh[0], count: Math.min(10, fresh[1]) }])}>+ Add item</button>}
      {options.length === 0 && <p className="muted small">{empty}</p>}
    </div>
  );
}

/** Your colonist close enough to a settlement to trade there, if any. */
function traderNear(faction: number, home: { x: number; y: number }): string | null {
  return traderAt(store.mirror, faction, home);
}

/** Draft the nearest free colonist and walk them to just outside the settlement's walls. */
function sendEnvoy(f: Faction): void {
  const who: Pawn | undefined = helpers(f.home.x, f.home.y).find((p) => !p.possessed);
  if (!who) {
    store.toast('Nobody is free to go.', 'bad');
    return;
  }
  // To a friend's gate; to an enemy, only just within trading range, on the side you come from.
  const hostile = !!f.settlement && dispositionOf(f.settlement, store.me?.faction ?? 0) === 'hostile';
  const d = Math.hypot(who.x - f.home.x, who.y - f.home.y) || 1;
  const reach = TRADE_RANGE - 1;
  const x = hostile ? Math.round(f.home.x + ((who.x - f.home.x) / d) * reach) : f.home.x;
  const y = hostile ? Math.round(f.home.y + ((who.y - f.home.y) / d) * reach) : Math.min(store.mirror.h - 1, f.home.y + 6);
  if (!who.drafted) command({ c: 'draft', pawns: [who.id], on: true });
  command({ c: 'move', pawns: [who.id], x, y });
  store.toast(
    hostile
      ? `${who.name.split(' ')[0]} is heading for the edge of ${f.name}'s trading range. Their guards will attack: trade quickly and get out (R to undraft).`
      : `${who.name.split(' ')[0]} is heading to ${f.name}. They stay drafted until you release them (R).`,
    hostile ? 'bad' : 'neutral',
    { x, y },
  );
}

type Partner = { faction: number; name: string; color: number; settlement: boolean };

export function TradePanel() {
  const s = useStore();
  const me = s.me?.faction ?? 0;
  const colonies: Partner[] = s.players.filter((p) => p.faction && p.faction !== me).map((p) => ({ faction: p.faction, name: p.name, color: p.color, settlement: false }));
  const settlements: Partner[] = [...s.mirror.factions.values()]
    .filter((f) => f.settlement && f.settlement.state !== 'fallen')
    .map((f) => ({ faction: f.id, name: f.name, color: f.color, settlement: true }));
  const partners = [...colonies, ...settlements];
  const [to, setTo] = useState<number>(s.tradeWith ?? partners[0]?.faction ?? 0);
  const [give, setGive] = useState<Line[]>([]);
  const [want, setWant] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  /** "Send a colonist" to enemies asks twice. */
  const [envoyArmed, setEnvoyArmed] = useState(0);
  // "Trade…" elsewhere in the HUD can point an open panel at someone new.
  useEffect(() => {
    if (s.tradeWith !== null && s.tradeWith !== to) {
      setTo(s.tradeWith);
      setWant([]);
    }
  }, [s.tradeWith]);
  const close = (
    <button className="close" onClick={() => store.set({ panel: 'none' })} aria-label="Close trade (Esc)" title="Close (Esc)">
      ×
    </button>
  );
  if (!partners.length) {
    return (
      <div className="panel trade-panel">
        {close}
        <h3>Trade</h3>
        <p className="muted">Nobody to trade with yet. Settlements show up on the map as walled towns; other players' colonies appear here once they join.</p>
      </div>
    );
  }
  const target = partners.find((p) => p.faction === to) ?? partners[0];
  const fac = s.mirror.factions.get(target.faction);
  const st = fac?.settlement;
  const lines = (l: Line[]): [string, number][] => l.map((x) => [x.item, x.count]);
  const myStock = stockOf(me);
  const theirStock = stockOf(target.faction);
  const short = give.some((l) => l.count > (myStock.get(l.item) ?? 0)) || want.some((l) => l.count > (theirStock.get(l.item) ?? 0));
  const send = () => {
    if (st) command({ c: 'settlementTrade', settlement: target.faction, give: lines(give), want: lines(want) });
    else {
      command({ c: 'offerTrade', to: target.faction, give: lines(give), want: lines(want), note });
      store.toast(`Offer sent to ${target.name}. It expires in 8 in-game hours.`, 'neutral');
    }
    setGive([]);
    setWant([]);
    setNote('');
  };
  const pick = (p: Partner) => {
    setTo(p.faction);
    setWant([]);
    store.tradeWith = p.faction;
  };
  let settlementInfo: React.ReactNode = null;
  let blocked = false;
  let why = '';
  const factor = st ? priceFactor(st, me) : 1;
  if (st && fac) {
    const trader = traderNear(me, fac.home);
    // The same rules the server applies (tested against it in trade.test.ts); stock is checked separately below.
    const deal = settlementDeal(st, me, lines(give), lines(want), !!trader);
    const mood = deal.mood;
    why =
      deal.why === 'moving'
        ? "They're on the move."
        : deal.why === 'no-trader'
          ? 'Nobody of yours is there.'
          : deal.why === 'hostile'
            ? "Enemies only take gifts: remove what you're asking for."
            : deal.why === 'value'
              ? `Offer ${worth(deal.wantV - deal.giveV)} more worth, or ask for less.`
              : '';
    blocked = deal.blocked;
    settlementInfo = (
      <div className="settlement-info">
        <p>
          <b style={{ color: hex(DISPOSITION_COLOR[mood]) }}>{mood[0].toUpperCase() + mood.slice(1)}</b>
          <span className="muted" title="Goodwill runs from -100 to 100. Fair trades, gifts and help raise it; theft and attacks lower it.">
            {' '}
            · goodwill {goodwillOf(st, me)} · their prices ×{factor.toFixed(2)}
          </span>
          <button className="link" onClick={() => store.set({ focus: { x: fac.home.x, y: fac.home.y } })}>
            Show on map
          </button>
        </p>
        <GoodwillMeter f={fac} />
        {mood === 'hostile' ? (
          <p className="bad small">
            They won't trade with you, and their guards attack your colonists on sight. A gift (give something, ask for nothing) might change their minds, if your envoy gets there{trader ? `: ${trader} is there now` : ''}.
          </p>
        ) : st.state !== 'home' ? (
          <p className="muted small">They're on the move, fleeing the frost.</p>
        ) : trader ? (
          <p className="small good">{trader} is there to make the trade. Your goods leave your stockpiles; theirs are left with {trader}.</p>
        ) : null}
        {!trader && st.state === 'home' && (
          <div className="envoy">
            <span className="muted small">A colonist must be within {TRADE_RANGE} cells of {fac.name} to trade or deliver.</span>
            {mood === 'hostile' ? (
              <button
                className={envoyArmed > performance.now() ? 'danger' : ''}
                onClick={() => {
                  if (envoyArmed > performance.now()) {
                    setEnvoyArmed(0);
                    sendEnvoy(fac);
                  } else setEnvoyArmed(performance.now() + 4000);
                }}
                title="Their guards attack your colonists on sight"
              >
                {envoyArmed > performance.now() ? 'Click again: guards will attack' : 'Send a colonist…'}
              </button>
            ) : (
              <button onClick={() => sendEnvoy(fac)} title="Draft the nearest colonist and walk them there">
                Send a colonist
              </button>
            )}
          </div>
        )}
        {(st.requests ?? [])
          .filter((r) => r.faction === me)
          .map((r) => {
            const have = r.item.startsWith('cat:') ? [...myStock.entries()].filter(([d]) => ITEMS[d].category === r.item.slice(4)).reduce((a, [, n]) => a + n, 0) : (myStock.get(r.item) ?? 0);
            const days = Math.max(0, (r.until - s.estTick()) / TICKS_PER_DAY);
            const reward = r.reward === 'recruit' ? 'a new colonist' : requestText(r.reward[0], r.reward[1]);
            const missing = !trader ? 'Send a colonist there first.' : have < r.count ? `You need ${r.count - have} more in your stockpiles.` : st.state !== 'home' ? "They're on the move." : '';
            return (
              <div key={r.id} className="request">
                <span>
                  They need <b>{requestText(r.item, r.count)}</b> <span className={have >= r.count ? 'good' : 'bad'}>(you have {have})</span> · {days >= 1 ? `${Math.ceil(days)}d` : `${Math.max(1, Math.round(days * 24))}h`} left · reward: {reward}
                  {missing && <small className="muted request-why">{missing}</small>}
                </span>
                <button disabled={!!missing} onClick={() => command({ c: 'deliverRequest', settlement: target.faction, request: r.id })} title={missing || 'Hand it over'}>
                  Deliver
                </button>
              </div>
            );
          })}
        <GoodwillRules />
      </div>
    );
  }
  const giveV = lineValue(lines(give));
  const wantV = lineValue(lines(want)) * factor;
  return (
    <div className="panel trade-panel" role="dialog" aria-label="Trade">
      {close}
      <h3>Trade</h3>
      <div className="partners" role="tablist">
        {partners.map((p) => {
          const pf = s.mirror.factions.get(p.faction);
          const pst = pf?.settlement;
          const mood = pst ? dispositionOf(pst, me) : null;
          const there = pf && pst ? traderNear(me, pf.home) : null;
          return (
            <button key={p.faction} role="tab" aria-selected={p.faction === target.faction} className={p.faction === target.faction ? 'on' : ''} onClick={() => pick(p)} title={pst ? `Settlement (${mood})${there ? `, ${there} is there` : ''}` : 'Player colony'}>
              <i style={{ background: hex(mood ? DISPOSITION_COLOR[mood] : p.color) }} /> {p.name}
              {pst && <small className="muted"> {there ? '· colonist there' : 'settlement'}</small>}
            </button>
          );
        })}
      </div>
      {st ? (
        settlementInfo
      ) : (
        <p className="muted small">Goods move between stockpiles only if they accept and both sides can still pay. Offers expire after 8 in-game hours.</p>
      )}
      <div className="trade-sides">
        <LineEditor title="You give" lines={give} setLines={setGive} stock={myStock} empty="Nothing in your stockpiles yet." factor={1} />
        <LineEditor title={st ? `You want (at their prices)` : 'You want'} lines={want} setLines={setWant} stock={theirStock} empty="Nothing in their stockpiles yet." factor={factor} />
      </div>
      {(give.length > 0 || want.length > 0) && (
        <div className="trade-balance">
          <span>You offer {worth(giveV)}</span>
          <span>{st ? 'they ask' : 'you ask'} {worth(wantV)}</span>
          {st && <span className={giveV + 1e-9 >= wantV ? 'good' : 'bad'}>{giveV + 1e-9 >= wantV ? (want.length ? 'Fair price' : 'A gift: raises goodwill') : 'Not enough'}</span>}
        </div>
      )}
      {!st && <input className="trade-note" placeholder="Add a note (optional)" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />}
      <div className="trade-actions">
        {(blocked || short) && (give.length > 0 || want.length > 0) && <span className="bad small">{short ? 'Some lines ask for more than is in stock.' : why}</span>}
        <button className="primary" disabled={(!give.length && !want.length) || blocked || short} onClick={send}>
          {st ? (give.length && !want.length ? 'Give as a gift' : 'Trade') : 'Send offer'}
        </button>
      </div>
    </div>
  );
}

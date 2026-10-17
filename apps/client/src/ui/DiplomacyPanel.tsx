import { useState } from 'react';
import {
  ALLY_AT,
  DIPLO,
  dispositionOf,
  FRIENDLY_AT,
  GOODWILL,
  goodwillOf,
  HOSTILE_AT,
  lineValue,
  liveTowns,
  mediationChance,
  MEDIATE_COOLDOWN_DAYS,
  pactOf,
  peacePrice,
  PLAYER_TRUCE_DAYS,
  rivalsOf,
  stanceOf,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TRADE_RANGE,
  TRUCE_DAYS,
  type Faction,
  type Stance,
} from '@fe/sim';
import { command } from '../net';
import { store, useStore } from '../store';
import { GoodwillMeter } from './SettlementCard';
import { LineEditor, sendEnvoy, stockOf, type Line } from './TradePanel';
import { envoyNear } from './trade';
import { hex } from './util';

export const STANCE_COLOR: Record<Stance, number> = {
  ally: 0x4fd18b,
  friendly: 0x7ad07a,
  peace: 0x8a96a6,
  truce: 0x6aa8e0,
  wary: 0xf0b43c,
  hostile: 0xf07a5a,
  war: 0xff4a4a,
};

export const STANCE_LABEL: Record<Stance, string> = {
  ally: 'Allies',
  friendly: 'Friendly',
  peace: 'At peace',
  truce: 'Truce',
  wary: 'Wary',
  hostile: 'Hostile',
  war: 'At war',
};

function StanceChip({ stance, rival }: { stance: Stance; rival?: boolean }) {
  const label = rival && stance === 'hostile' ? 'Rivals' : STANCE_LABEL[stance];
  return (
    <span className="chip stance" style={{ color: hex(STANCE_COLOR[stance]), borderColor: hex(STANCE_COLOR[stance]) }}>
      {label}
    </span>
  );
}

const ago = (ticks: number) => (ticks >= TICKS_PER_DAY ? `${Math.floor(ticks / TICKS_PER_DAY)}d ago` : ticks >= TICKS_PER_HOUR ? `${Math.floor(ticks / TICKS_PER_HOUR)}h ago` : 'just now');
const hoursLeft = (until: number | undefined, now: number) => Math.max(1, Math.ceil(((until ?? now) - now) / TICKS_PER_HOUR));

/** A button that asks twice: the first click arms it for a few seconds. */
function ConfirmButton({ label, confirm, onConfirm, title, disabled }: { label: string; confirm: string; onConfirm: () => void; title?: string; disabled?: boolean }) {
  const [armed, setArmed] = useState(0);
  const live = armed > performance.now();
  return (
    <button
      className={live ? 'danger' : ''}
      disabled={disabled}
      title={title}
      onClick={() => {
        if (live) {
          setArmed(0);
          onConfirm();
        } else setArmed(performance.now() + 4000);
      }}
    >
      {live ? confirm : label}
    </button>
  );
}

/** Requirement line: ✓ or ✗ and why. */
function Need({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <li className={ok ? 'good' : 'bad'}>{ok ? '✓' : '✗'} {children}</li>;
}

/** Everyone you deal with: towns and other colonies, how they stand with you and each other, and what you can do about it. */
export function DiplomacyPanel() {
  const s = useStore();
  const m = s.mirror;
  const me = s.me?.faction ?? 0;
  const towns = liveTowns(m);
  const colonies = [...m.factions.values()].filter((f) => f.isPlayer && f.id !== me);
  const all = [...towns, ...colonies];
  const close = (
    <button className="close" onClick={() => store.set({ panel: 'none' })} aria-label="Close diplomacy (Esc)" title="Close (Esc)">
      ×
    </button>
  );
  if (!all.length) {
    return (
      <div className="panel trade-panel diplo-panel">
        {close}
        <h3>Diplomacy</h3>
        <p className="muted">Nobody to deal with yet. Towns and other colonies appear here.</p>
      </div>
    );
  }
  const sel = all.find((f) => f.id === s.diploWith) ?? all[0];
  return (
    <div className="panel trade-panel diplo-panel" role="dialog" aria-label="Diplomacy">
      {close}
      <h3>Diplomacy</h3>
      <div className="diplo-body">
        <div className="diplo-list" role="tablist">
          {all.map((f) => {
            const stance = stanceOf(m, me, f.id);
            const met = !f.settlement || f.settlement.met.includes(me);
            return (
              <button key={f.id} role="tab" aria-selected={f.id === sel.id} className={f.id === sel.id ? 'on' : ''} onClick={() => store.set({ diploWith: f.id })}>
                <i style={{ background: hex(f.color) }} />
                <span className="diplo-name">{f.name}</span>
                {met ? <StanceChip stance={stance} /> : <span className="muted small">not met</span>}
                {f.settlement && met && <small className="muted">{goodwillOf(f.settlement, me)}</small>}
              </button>
            );
          })}
          <RelationsWeb factions={[...(m.factions.get(me) ? [m.factions.get(me)!] : []), ...all]} />
        </div>
        <div className="diplo-detail">{sel.settlement ? <TownDetail f={sel} /> : <ColonyDetail f={sel} />}</div>
      </div>
    </div>
  );
}

/** Everyone against everyone: a grid coloured by how each pair stands. */
function RelationsWeb({ factions }: { factions: Faction[] }) {
  const m = store.mirror;
  const me = store.me?.faction ?? 0;
  if (factions.length < 3) return null;
  const short = (f: Faction) => (f.id === me ? 'You' : f.name.replace(/'s colony$/, ''));
  return (
    <div className="relations-web" aria-label="Who stands how with whom">
      <h4>Who stands where</h4>
      <table>
        <thead>
          <tr>
            <th />
            {factions.map((f) => (
              <th key={f.id} title={f.name}>
                <i style={{ background: hex(f.color) }} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {factions.map((a) => (
            <tr key={a.id}>
              <th title={a.name}>{short(a)}</th>
              {factions.map((b) => {
                if (a.id === b.id) return <td key={b.id} className="self" />;
                const st = stanceOf(m, a.id, b.id);
                const rival = !!a.settlement && !!b.settlement && st === 'hostile';
                return <td key={b.id} style={{ background: hex(STANCE_COLOR[st]) }} title={`${short(a)} and ${short(b)}: ${rival ? 'rivals' : STANCE_LABEL[st].toLowerCase()}`} />;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TownDetail({ f }: { f: Faction }) {
  const s = useStore();
  const m = s.mirror;
  const me = s.me?.faction ?? 0;
  const st = f.settlement!;
  const now = s.estTick();
  const [tribute, setTribute] = useState<Line[]>([]);
  if (st.state === 'fallen') return <p className="muted">{f.name} has fallen.</p>;
  const met = st.met.includes(me);
  const g = goodwillOf(st, me);
  const mood = dispositionOf(st, me);
  const pact = pactOf(m, me, f.id);
  const envoy = envoyNear(m, me, f.home);
  const rivals = rivalsOf(m, f);
  const myRivalAllies = rivals.filter((r) => pactOf(m, me, r.id)?.kind === 'ally');
  const memories = (st.memories ?? []).filter((x) => x.f === me).slice(-8).reverse();
  const neighbours = liveTowns(m).filter((o) => o.id !== f.id);
  const atHome = st.state === 'home';
  return (
    <>
      <div className="sc-head">
        <b>{f.name}</b>
        {met ? <StanceChip stance={stanceOf(m, me, f.id)} /> : <span className="muted small">You haven't met yet: bring a colonist within {st.radius + 10} cells.</span>}
        {st.state === 'leaving' && <span className="muted small">on the move, fleeing the frost</span>}
      </div>
      <GoodwillMeter f={f} />
      <div className="diplo-why">
        <h4>Why they feel this way</h4>
        {memories.length ? (
          <ul>
            {memories.map((x, i) => (
              <li key={i} className={x.by >= 0 ? 'good' : 'bad'}>
                <b>
                  {x.by > 0 ? '+' : ''}
                  {x.by}
                </b>{' '}
                {x.why} <span className="muted">· {ago(now - x.tick)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Nothing yet: they judge you by their nature ({st.temper >= FRIENDLY_AT ? 'welcoming' : st.temper <= HOSTILE_AT ? 'hostile to outsiders' : 'cautious'}). Feelings drift back toward that a point a day.</p>
        )}
      </div>
      <div className="diplo-why">
        <h4>Their neighbours</h4>
        {neighbours.length ? (
          <ul className="neighbours">
            {neighbours.map((o) => {
              const stance = stanceOf(m, f.id, o.id);
              const rival = rivals.includes(o);
              return (
                <li key={o.id}>
                  <button className="link" onClick={() => store.set({ diploWith: o.id })}>
                    {o.name}
                  </button>{' '}
                  <StanceChip stance={stance} rival={rival} />
                  {rival && <span className="muted small"> help one and the other resents you</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted small">No other towns.</p>
        )}
      </div>

      {met && atHome && pact?.kind === 'ally' && (
        <section className="diplo-act">
          <h4>Alliance</h4>
          <p className="small">They send up to two fighters when you are raided, and call on you when they are. Staying home when they call costs {-DIPLO.abandoned} goodwill. It holds while goodwill stays at {FRIENDLY_AT} or more.</p>
          <ConfirmButton
            label="End the alliance…"
            confirm={`Click again: ${DIPLO.brokeAlliance} here, ${DIPLO.oathbreakerRumor} with every town that knows you`}
            onConfirm={() => command({ c: 'diplomacy', act: 'breakAlly', target: f.id })}
          />
        </section>
      )}

      {met && atHome && !pact && mood !== 'hostile' && (
        <section className="diplo-act">
          <h4>Alliance</h4>
          <ul className="needs">
            <Need ok={g >= ALLY_AT}>
              Goodwill {ALLY_AT} or more (now {g})
            </Need>
            <Need ok={!!envoy}>{envoy ? `${envoy.name} is there to speak for you` : `A colonist within ${TRADE_RANGE} cells of ${f.name}`}</Need>
            <Need ok={!myRivalAllies.length}>{myRivalAllies.length ? `You're allied with their rival ${myRivalAllies.map((r) => r.name).join(', ')}` : 'Not allied with their rivals'}</Need>
          </ul>
          <div className="diplo-buttons">
            <button className="primary" disabled={g < ALLY_AT || !envoy || myRivalAllies.length > 0} onClick={() => command({ c: 'diplomacy', act: 'ally', target: f.id })}>
              Propose an alliance
            </button>
            {!envoy && <button onClick={() => sendEnvoy(f)}>Send a colonist</button>}
          </div>
          {rivals.length > 0 && (
            <p className="muted small">
              Their rivals ({rivals.map((r) => r.name).join(', ')}) will take it badly: {DIPLO.alliedWithRival} goodwill.
            </p>
          )}
        </section>
      )}

      {met && pact?.kind === 'truce' && (
        <section className="diplo-act">
          <h4>Truce</h4>
          <p className="small">
            Their guards let your people be for another {hoursLeft(pact.until, now)}h. Attacking them breaks it: {DIPLO.brokeTruce} here and {DIPLO.oathbreakerRumor} with every town that knows you.
          </p>
        </section>
      )}

      {met && atHome && mood === 'hostile' && !pact && (
        <PeaceOffer f={f} g={g} social={envoy?.social ?? 0} envoy={envoy?.name ?? null} tribute={tribute} setTribute={setTribute} />
      )}

      {met && atHome && rivals.length > 0 && (
        <section className="diplo-act">
          <h4>Make peace between rivals</h4>
          <p className="muted small">
            Talk two feuding towns round. Success: +{DIPLO.mediated} with both, +{DIPLO.peacemakerRumor} with every other town that knows you. Failure: {DIPLO.meddled} with both. Either way they won't hear more for {MEDIATE_COOLDOWN_DAYS} days.
          </p>
          {rivals.map((r) => {
            const rs = r.settlement!;
            const gr = goodwillOf(rs, me);
            const there = envoy ?? envoyNear(m, me, r.home);
            const last = st.mediated?.[r.id];
            const cooling = last !== undefined && now - last < MEDIATE_COOLDOWN_DAYS * TICKS_PER_DAY;
            const problem = !rs.met.includes(me)
              ? `You haven't met ${r.name}.`
              : rs.state !== 'home'
                ? `${r.name} is on the move.`
                : g <= HOSTILE_AT || gr <= HOSTILE_AT
                  ? 'Neither will take an enemy as go-between.'
                  : !there
                    ? `Send a colonist to ${f.name} or ${r.name}.`
                    : cooling
                      ? 'They need a day or two before more talk.'
                      : null;
            const chance = Math.round(mediationChance(g, gr, there?.social ?? 0) * 100);
            return (
              <div key={r.id} className="mediate-row">
                <span>
                  {f.name} and <b>{r.name}</b> {problem ? <small className="muted">· {problem}</small> : <small className="muted">· {chance}% chance</small>}
                </span>
                <button disabled={!!problem} onClick={() => command({ c: 'diplomacy', act: 'mediate', target: f.id, other: r.id })}>
                  Talk peace
                </button>
              </div>
            );
          })}
        </section>
      )}

      {met && atHome && (
        <div className="diplo-buttons">
          {mood !== 'hostile' && <button onClick={() => store.openTrade(f.id)}>Trade…</button>}
          <button className="link" onClick={() => store.set({ focus: { x: f.home.x, y: f.home.y } })}>
            Show on map
          </button>
          {mood !== 'hostile' && (
            <ConfirmButton label="Declare war…" confirm="Click again: they become enemies" onConfirm={() => command({ c: 'diplomacy', act: 'war', target: f.id })} title="Turns them hostile: their guards attack your colonists on sight" />
          )}
        </div>
      )}
    </>
  );
}

function PeaceOffer({ f, g, social, envoy, tribute, setTribute }: { f: Faction; g: number; social: number; envoy: string | null; tribute: Line[]; setTribute: (l: Line[]) => void }) {
  const me = store.me?.faction ?? 0;
  const price = peacePrice(g, social);
  const value = lineValue(tribute.map((l) => [l.item, l.count]));
  const stock = stockOf(me);
  const short = tribute.some((l) => l.count > (stock.get(l.item) ?? 0));
  return (
    <section className="diplo-act">
      <h4>Sue for peace</h4>
      <p className="small">
        They want tribute worth about <b>{price}</b> to stop fighting{social > 0 ? ` (your envoy's Social ${social} talks it down)` : ''}. Pay it and goodwill goes back to {HOSTILE_AT + 15}, with a {TRUCE_DAYS}-day truce. Gifts in the Trade panel help too (+1 per {GOODWILL.giftValue} worth).
      </p>
      {!envoy && (
        <p className="bad small">
          Your envoy has to reach them first, and their guards attack on sight.{' '}
          <button className="link" onClick={() => sendEnvoy(f)}>
            Send a colonist…
          </button>
        </p>
      )}
      <LineEditor title="Tribute" lines={tribute} setLines={setTribute} stock={stock} empty="Nothing in your stockpiles to offer." factor={1} />
      <div className="trade-balance">
        <span>You offer {Math.round(value)}</span>
        <span className={value + 1e-9 >= price ? 'good' : 'bad'}>{value + 1e-9 >= price ? 'Enough for a truce' : `${Math.ceil(price - value)} short`}</span>
      </div>
      <button
        className="primary"
        disabled={!envoy || value + 1e-9 < price || short || !tribute.length}
        onClick={() => {
          command({ c: 'diplomacy', act: 'peace', target: f.id, give: tribute.map((l) => [l.item, l.count]) });
          setTribute([]);
        }}
      >
        Offer tribute
      </button>
    </section>
  );
}

function ColonyDetail({ f }: { f: Faction }) {
  const s = useStore();
  const m = s.mirror;
  const me = s.me?.faction ?? 0;
  const pact = pactOf(m, me, f.id);
  const now = s.estTick();
  const owner = s.players.find((p) => p.faction === f.id);
  return (
    <>
      <div className="sc-head">
        <b>{f.name}</b>
        <StanceChip stance={stanceOf(m, me, f.id)} />
        <span className="muted small">{owner ? (owner.connected ? `${owner.name} is online` : `${owner.name} is away`) : 'another colony'}</span>
      </div>
      {!pact && (
        <p className="small">
          At peace. Neither side's colonists fight the other's unless ordered to. Attacking them without declaring war is a surprise attack: it starts a war, and every town that knows you thinks less of you ({DIPLO.treacheryRumor}).
        </p>
      )}
      {pact?.kind === 'ally' && <p className="small good">Allies. Your doors open to each other's colonists, you see what their colonists see, you hear when they are raided, and neither can order an attack on the other.</p>}
      {pact?.kind === 'war' && <p className="small bad">At war. Your colonists and theirs fight on sight. Peace needs both of you to agree.</p>}
      {pact?.kind === 'truce' && (
        <p className="small">
          A truce for another {hoursLeft(pact.until, now)}h, then peace. Breaking it with an attack is remembered by every town that knows you.
        </p>
      )}
      <div className="diplo-buttons">
        {pact?.kind !== 'ally' && pact?.kind !== 'war' && (
          <button className="primary" onClick={() => command({ c: 'diplomacy', act: 'ally', target: f.id })} title="They get a letter to accept or decline">
            Propose an alliance
          </button>
        )}
        {pact?.kind === 'war' && (
          <button className="primary" onClick={() => command({ c: 'diplomacy', act: 'peace', target: f.id })} title={`They get a letter; accepting starts a ${PLAYER_TRUCE_DAYS}-day truce`}>
            Offer peace
          </button>
        )}
        {pact?.kind === 'ally' && <ConfirmButton label="End the alliance…" confirm="Click again to end it" onConfirm={() => command({ c: 'diplomacy', act: 'breakAlly', target: f.id })} />}
        {pact?.kind !== 'war' && (
          <ConfirmButton
            label="Declare war…"
            confirm={pact?.kind === 'ally' || pact?.kind === 'truce' ? `Click again: you break your word (${DIPLO.oathbreakerRumor} with towns)` : 'Click again: your colonists will fight theirs on sight'}
            onConfirm={() => command({ c: 'diplomacy', act: 'war', target: f.id })}
          />
        )}
        <button onClick={() => store.openTrade(f.id)}>Trade…</button>
        <button className="link" onClick={() => store.set({ focus: { x: f.home.x, y: f.home.y } })}>
          Show on map
        </button>
      </div>
    </>
  );
}

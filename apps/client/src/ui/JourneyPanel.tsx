import { useState } from 'react';
import { ITEM_CATEGORIES, ITEMS } from '@fe/defs';
import { caravanLoad, carryCapacity, LOAD_RADIUS, MAX_VIA, sledgesIn, type Caravan } from '@fe/sim';
import { command } from '../net';
import { store, useStore } from '../store';
import { daysText, frostDays } from './OrderPreview';
import { candidates, crossings, hoursFor, loadable, passCells, planLoad, routeLength, siteTrouble, type Point } from './journey';

const goodsText = (lines: [string, number][], max = 6) => {
  const sorted = [...lines].sort((a, b) => (ITEMS[b[0]]?.marketValue ?? 0) * b[1] - (ITEMS[a[0]]?.marketValue ?? 0) * a[1]);
  const shown = sorted.slice(0, max).map(([d, n]) => `${n} ${ITEMS[d]?.label.toLowerCase() ?? d}`);
  return shown.join(', ') + (sorted.length > max ? `, and ${sorted.length - max} more` : '');
};

const hoursText = (h: number) => (h < 0.75 ? 'under an hour' : h < 1.5 ? 'about an hour' : h < 20 ? `about ${Math.round(h)} hours` : `about ${(h / 24).toFixed(1)} days`);

/** Planning the move inward: where, through where, who goes, what they take, and what the road holds. */
export function JourneyPanel() {
  const s = useStore();
  const m = s.mirror;
  const me = s.me?.faction ?? 0;
  const f = m.factions.get(me);
  const j = s.journey ?? { dest: null, via: [], members: null, take: null };
  if (!f || s.tool.kind !== 'moveHome') return null;
  const close = () => store.set({ tool: { kind: 'select' }, journey: null });
  const people = candidates(m, me);
  const members = j.members ?? people.map((p) => p.id);
  const take = j.take ?? ITEM_CATEGORIES.map((c) => c.key);
  const goods = loadable(m, me, f.home);
  const plan = planLoad(goods, members.length, j.take ?? []);
  const points: Point[] = j.dest ? [f.home, ...j.via, j.dest] : [];
  const length = routeLength(points);
  const hours = hoursFor(length, plan.capacity ? plan.bulk / plan.capacity : 0);
  const towns = j.dest ? crossings(m, me, points, plan.cargo) : [];
  const passes = j.dest ? passCells(m, points) : 0;
  const days = j.dest ? frostDays(j.dest.x, j.dest.y) : Infinity;
  const trouble = j.dest ? siteTrouble(m, me, s.estTick(), j.dest.x, j.dest.y) : null;
  const hereDays = frostDays(f.home.x, f.home.y);
  const food = plan.cargo.filter(([d]) => ITEMS[d]?.nutrition).reduce((a, [d, n]) => a + (ITEMS[d].nutrition ?? 0) * n, 0);
  const set = (patch: Partial<typeof j>) => store.set({ journey: { ...j, ...patch } });
  const go = () => {
    if (!j.dest) return;
    command({ c: 'caravan', act: 'form', pawns: members, x: j.dest.x, y: j.dest.y, via: j.via.map((v) => [v.x, v.y]), take: j.take ?? [] });
    close();
  };
  return (
    <div className="panel trade-panel journey-panel" role="dialog" aria-label="Plan the journey">
      <button className="close" onClick={close} aria-label="Close (Esc)" title="Close (Esc)">
        ×
      </button>
      <h3>Move the colony</h3>
      {!j.dest ? (
        <p className="small">
          Click the map where the colony should go: further in stays warm longer. <span className="muted">Shift-click to route it through waypoints (up to {MAX_VIA}).</span>
        </p>
      ) : (
        <>
          {trouble && <p className="bad small">Can't settle there: {trouble} Pick another spot.</p>}
          <div className="journey-facts">
            <span>
              <b>{Math.round(length)}</b> cells, {hoursText(hours)} on the road
            </span>
            <span className={days === 0 ? 'bad' : days > hereDays ? 'good' : 'bad'}>Frost there: {daysText(days)} (here: {daysText(hereDays)})</span>
            {j.via.length > 0 && (
              <span>
                via {j.via.length} waypoint{j.via.length > 1 ? 's' : ''}{' '}
                <button className="link" onClick={() => set({ via: [] })}>
                  clear
                </button>
              </span>
            )}
          </div>
          <ul className="journey-road">
            {towns.map((c) => (
              <li key={c.town.id} className={c.kind === 'hostile' ? 'bad' : c.kind === 'toll' ? '' : 'good'}>
                {c.kind === 'ally' && `${c.town.name}, your ally, will wave you through.`}
                {c.kind === 'friendly' && `${c.town.name} is friendly: free passage.`}
                {c.kind === 'toll' && `${c.town.name} will ask a toll of about ${c.toll} (refusing costs goodwill).`}
                {c.kind === 'hostile' && `${c.town.name} is hostile: its guards will attack the caravan. Route around it with a waypoint.`}
              </li>
            ))}
            {passes > 0 && <li className="bad">The route runs through mountain passes: raiders sometimes lie in wait there.</li>}
            {!towns.length && !passes && <li className="good muted">Nothing known on the road.</li>}
          </ul>
        </>
      )}
      <div className="journey-cols">
        <div>
          <h4>Who goes</h4>
          {people.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={members.includes(p.id)} onChange={(e) => set({ members: e.target.checked ? [...members, p.id] : members.filter((id) => id !== p.id) })} />
              {p.name}
            </label>
          ))}
          <p className="muted small">Those who stay keep working at the old site.</p>
        </div>
        <div>
          <h4>What to take</h4>
          {ITEM_CATEGORIES.map((c) => (
            <label key={c.key} className="check">
              <input type="checkbox" checked={take.includes(c.key)} onChange={(e) => set({ take: e.target.checked ? [...take, c.key] : take.filter((k) => k !== c.key) })} />
              {c.label}
            </label>
          ))}
          <p className="muted small">From your stockpiles within {LOAD_RADIUS} cells of home. Pack up the old site first (Orders → Pack up) to bring beds and benches as kits.</p>
        </div>
      </div>
      <div className="journey-load">
        <div className="load-bar" title="Bulk carried / what the group can carry">
          <i style={{ width: `${plan.capacity ? Math.min(100, (plan.bulk / plan.capacity) * 100) : 0}%` }} />
        </div>
        <span className="small">
          Carrying {Math.round(plan.bulk)} of {plan.capacity}
          {plan.sledges ? ` (${plan.sledges} sledge${plan.sledges > 1 ? 's' : ''})` : ' · a sledge (Workbench) carries 300 more'} · food for about {Math.max(0, Math.floor(food / Math.max(1, members.length)))} meals each
        </span>
        {plan.cargo.length > 0 && <p className="small">Takes: {goodsText(plan.cargo)}</p>}
        {plan.left.length > 0 && <p className="small muted">Leaves behind: {goodsText(plan.left)}</p>}
      </div>
      <div className="trade-actions">
        <button className="primary" disabled={!j.dest || !members.length || !!trouble} onClick={go} title={!j.dest ? 'Pick a destination on the map first' : (trouble ?? '')}>
          Set out
        </button>
      </div>
    </div>
  );
}

/** The caravan on its way: where it is, what it carries, and stop / go on / call off. */
export function CaravanCard() {
  const s = useStore();
  const f = s.mirror.factions.get(s.me?.faction ?? 0);
  const c: Caravan | undefined = f?.caravan;
  const [armed, setArmed] = useState(0);
  if (!c) return null;
  const cap = carryCapacity(c.members.length, sledgesIn(c.cargo));
  const food = c.cargo.filter(([d]) => ITEMS[d]?.nutrition).reduce((a, [d, n]) => a + (ITEMS[d].nutrition ?? 0) * n, 0);
  const pct = c.route.length ? Math.round((Math.min(c.leg, c.route.length) / c.route.length) * 100) : 0;
  const status =
    c.phase === 'muster'
      ? 'Gathering and loading at home'
      : c.phase === 'camp'
        ? c.shelter
          ? `Sheltering in ${s.mirror.factions.get(c.shelter)?.name ?? 'a town'} for the night`
          : 'Camped for the night'
        : c.phase === 'halt'
          ? 'Stopped'
          : c.waiting !== undefined
            ? 'Waiting on your answer to a toll'
            : `On the road, ${pct}% of the way`;
  const at = c.at;
  return (
    <div className="panel caravan-card" role="region" aria-label="Caravan">
      <b>Caravan</b>
      <span>{status}</span>
      {c.phase !== 'muster' && (
        <span className="muted small">
          {c.members.length}
          {c.wounded?.length ? ` + ${c.wounded.length} wounded carried` : ''} · carrying {Math.round(caravanLoad(c))}/{cap} · food {Math.floor(food / Math.max(1, c.members.length))} meals each
        </span>
      )}
      {at !== undefined && (
        <button className="link" onClick={() => store.set({ focus: { x: at % s.mirror.w, y: Math.floor(at / s.mirror.w) } })}>
          Show
        </button>
      )}
      {c.phase === 'travel' && <button onClick={() => command({ c: 'caravan', act: 'halt' })}>Halt</button>}
      {c.phase === 'halt' && <button onClick={() => command({ c: 'caravan', act: 'resume' })}>Go on</button>}
      <button
        className={armed > performance.now() ? 'danger' : ''}
        onClick={() => {
          if (armed > performance.now()) {
            setArmed(0);
            command({ c: 'caravan', act: 'disband' });
          } else setArmed(performance.now() + 4000);
        }}
        title="Set the goods down where the caravan stands and stop"
      >
        {armed > performance.now() ? 'Click again to call it off' : 'Call off'}
      </button>
    </div>
  );
}

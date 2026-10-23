import { BUILDINGS, CONDITIONS, ITEMS } from '@fe/defs';
import { allied, atWar, calendar, contractText, daysUntilFrost, DAYS_PER_SEASON, requestText, stageOf, TICKS_PER_DAY, type Building, type Item, type Pawn } from '@fe/sim';
import { store, useStore } from '../store';

export type Severity = 'critical' | 'warning' | 'info';

export interface Alert {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Where to jump when clicked. */
  focus?: { x: number; y: number; select?: number };
  /** Also open the Trade panel on this partner when clicked. */
  trade?: number;
  /** Also open the Diplomacy panel on this faction when clicked. */
  diplo?: number;
}

/** How close (cells from your home) another colony's people count as "at your door" in a war. */
const WAR_NEAR = 30;

const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Everything worth nagging about, derived from the client's copy of the world. */
export function computeAlerts(): Alert[] {
  const m = store.mirror;
  const me = store.me?.faction;
  if (!me) return [];
  const pawns: Pawn[] = [];
  const beds: Building[] = [];
  let storedNutrition = 0;
  for (const e of m.entities.values()) {
    if (e.kind === 'pawn' && e.faction === me) pawns.push(e);
    else if (e.kind === 'building' && e.faction === me && BUILDINGS[e.def]?.bed) beds.push(e);
    else if (e.kind === 'item') {
      // Food in our stockpiles, or lying loose near home, counts as ours.
      const z = m.zoneAt[e.y * m.w + e.x];
      const zf = z ? m.zones.get(z)?.faction : 0;
      const home = m.factions.get(me)?.home;
      const near = home && Math.max(Math.abs(e.x - home.x), Math.abs(e.y - home.y)) <= 30;
      if (zf === me || (!zf && near)) storedNutrition += (ITEMS[(e as Item).def]?.nutrition ?? 0) * (e as Item).count;
    }
  }
  const out: Alert[] = [];
  const at = (p: Pawn) => ({ x: p.x, y: p.y, select: p.id });

  for (const p of pawns) {
    for (const c of p.conditions) {
      const def = CONDITIONS[c.key];
      if (!def) continue;
      if (def.lethal && c.severity >= 0.6) {
        out.push({ key: `dying-${p.id}-${c.key}`, severity: 'critical', title: `${p.name.split(' ')[0]}: ${def.label.toLowerCase()}`, detail: `${stageOf(def, c.severity).label}, ${Math.round(c.severity * 100)}%. This can kill.`, focus: at(p) });
      } else if (def.kind === 'exposure' && c.severity >= 0.3) {
        out.push({ key: `exp-${p.id}-${c.key}`, severity: 'warning', title: `${p.name.split(' ')[0]}: ${def.label.toLowerCase()}`, detail: c.key === 'hypothermia' ? 'Needs a heated room or a campfire.' : c.key === 'heatstroke' ? 'Needs a cooler room.' : 'Needs food.', focus: at(p) });
      } else if (def.kind === 'mental') {
        out.push({ key: `mental-${p.id}`, severity: 'warning', title: `${p.name.split(' ')[0]}: ${def.label.toLowerCase()}`, detail: 'Mental break. Improve their mood.', focus: at(p) });
      }
    }
    if (p.needs.food < 0.1 && !p.conditions.some((c) => c.key === 'malnutrition')) {
      out.push({ key: `hungry-${p.id}`, severity: 'warning', title: `${p.name.split(' ')[0]} is starving`, detail: 'No food they can reach.', focus: at(p) });
    }
  }
  const sick = pawns.filter((p) => p.conditions.some((c) => CONDITIONS[c.key]?.kind === 'disease'));
  if (sick.length) out.push({ key: 'sick', severity: 'info', title: `${sick.length} sick`, detail: sick.map((p) => p.name.split(' ')[0]).join(', '), focus: at(sick[0]) });

  // Raiders, and what they're up to right now.
  for (const f of m.factions.values()) {
    const raid = f.raid;
    if (!raid || raid.fled || raid.target !== me) continue;
    const raiders = [...m.entities.values()].filter((e): e is Pawn => e.kind === 'pawn' && e.faction === f.id && !e.downed);
    if (!raiders.length) continue;
    const goal = raid.goal ?? 'assault';
    const chief = raid.chief ? raiders.find((p) => p.id === raid.chief) : undefined;
    if (raid.parley && raid.parley > store.estTick()) {
      out.push({ key: `raid-${f.id}`, severity: 'critical', title: `${f.name}: waiting for your answer (${raiders.length})`, detail: `${raid.chiefName ?? 'Their chief'} demands tribute: answer the letter. Use the time to draft (R) and get behind cover.`, focus: { x: raiders[0].x, y: raiders[0].y } });
      continue;
    }
    const what = { assault: 'Attacking', loot: 'Looting your stores', burn: 'Setting fires', siege: 'Besieging you', camp: 'Holding their camp' }[goal];
    const how = {
      assault: 'Hold them off from behind cover: embrasures and sandbags.',
      loot: 'They gave up on your walls. Anything left outside is fair game to them.',
      burn: 'Firefighters will need cover; or wait them out.',
      siege: "They're dug in out there. Stay behind cover; they'll give up.",
      camp: 'They fight anyone who comes close.',
    }[goal];
    const lead = chief ? ` Bring down ${chief.name} (click) and the rest will break.` : '';
    const spot = chief ?? raiders[0];
    out.push({ key: `raid-${f.id}`, severity: 'critical', title: `${f.name}: ${what.toLowerCase()} (${raiders.length})`, detail: how + lead, focus: { x: spot.x, y: spot.y, select: chief?.id } });
  }

  // Raids on allies: you can't stop them from the alert, but you can go and help.
  for (const f of m.factions.values()) {
    const raid = f.raid;
    if (!raid || raid.fled || raid.target === me || !allied(m, me, raid.target)) continue;
    const ally = m.factions.get(raid.target);
    if (!ally?.isPlayer) continue;
    const raiders = [...m.entities.values()].filter((e): e is Pawn => e.kind === 'pawn' && e.faction === f.id && !e.downed);
    if (!raiders.length) continue;
    out.push({ key: `allyraid-${f.id}`, severity: 'warning', title: `Your ally ${ally.name} is being raided (${raiders.length})`, detail: `${f.name} is attacking them. Draft colonists (R) and send help, if you can spare them.`, focus: { x: raiders[0].x, y: raiders[0].y } });
  }

  // Wars with other colonies: always listed, and urgent once their people are at your door.
  const myHome = m.factions.get(me)?.home;
  for (const f of m.factions.values()) {
    if (!f.isPlayer || f.id === me || !atWar(m, me, f.id)) continue;
    const near = myHome ? [...m.entities.values()].filter((e): e is Pawn => e.kind === 'pawn' && e.faction === f.id && !e.downed && !e.prisoner && Math.max(Math.abs(e.x - myHome.x), Math.abs(e.y - myHome.y)) <= WAR_NEAR) : [];
    if (near.length) {
      out.push({ key: `war-near-${f.id}`, severity: 'critical', title: `${f.name}: ${near.length} of theirs at your colony`, detail: "You're at war: their colonists and yours fight on sight. Draft (R) and get behind cover.", focus: { x: near[0].x, y: near[0].y } });
    } else {
      out.push({ key: `war-${f.id}`, severity: 'warning', title: `At war with ${f.name}`, detail: 'Your colonists and theirs fight on sight. Click to offer peace (Diplomacy).', focus: { x: f.home.x, y: f.home.y }, diplo: f.id });
    }
  }

  // An ally's war reaching their door: the same as a raid on them, as far as you're concerned.
  for (const a of m.factions.values()) {
    if (!a.isPlayer || a.id === me || !allied(m, me, a.id)) continue;
    for (const e of m.factions.values()) {
      if (!e.isPlayer || e.id === me || e.id === a.id || !atWar(m, a.id, e.id)) continue;
      const near = [...m.entities.values()].filter((p): p is Pawn => p.kind === 'pawn' && p.faction === e.id && !p.downed && !p.prisoner && Math.max(Math.abs(p.x - a.home.x), Math.abs(p.y - a.home.y)) <= WAR_NEAR);
      if (near.length) out.push({ key: `allywar-${a.id}-${e.id}`, severity: 'warning', title: `Your ally ${a.name} is under attack (${near.length})`, detail: `${e.name}, at war with them, has people at their colony. Send help if you can spare it.`, focus: { x: near[0].x, y: near[0].y } });
    }
  }

  // Promises to settlements.
  for (const f of m.factions.values()) {
    for (const r of f.settlement?.requests ?? []) {
      if (r.faction !== me) continue;
      const days = (r.until - store.estTick()) / TICKS_PER_DAY;
      out.push({
        key: `request-${r.id}`,
        severity: days < 1 ? 'warning' : 'info',
        title: `${f.name} wants ${requestText(r.item, r.count)}`,
        detail: `${days < 1 ? `Under ${Math.max(1, Math.round(days * 24))} hours` : `${Math.ceil(days)} days`} left. Send a colonist and deliver from the Trade panel (click).`,
        focus: { x: f.home.x, y: f.home.y },
        trade: f.id,
      });
    }
  }

  // Jobs taken on for towns.
  for (const f of m.factions.values()) {
    for (const j of f.settlement?.contracts ?? []) {
      if (j.faction !== me) continue;
      const days = (j.until - store.estTick()) / TICKS_PER_DAY;
      const left = j.targets.filter((id) => {
        const p = m.get(id);
        return p?.kind === 'pawn' && !p.downed && !p.prisoner;
      }).length;
      out.push({
        key: `contract-${j.id}`,
        severity: days < 1 ? 'warning' : 'info',
        title: `${f.name}'s job: ${contractText(j)} (${left} left)`,
        detail: `${days < 1 ? `Under ${Math.max(1, Math.round(days * 24))} hours` : `${Math.ceil(days)} days`} left. Draft a few colonists and go (click to look). Reward: ${requestText(j.reward[0], j.reward[1])}.`,
        focus: { x: j.at % m.w, y: Math.floor(j.at / m.w) },
      });
    }
  }

  const idle = pawns.filter((p) => !p.job || p.job.type === 'wander');
  if (idle.length) out.push({ key: 'idle', severity: 'info', title: `${idle.length} idle colonist${idle.length > 1 ? 's' : ''}`, detail: 'Give them orders or check work priorities.', focus: at(idle[0]) });

  if (beds.length < pawns.length) out.push({ key: 'beds', severity: 'info', title: 'Need beds', detail: `${pawns.length - beds.length} colonist${pawns.length - beds.length > 1 ? 's' : ''} sleep on the ground.` });

  const daysOfFood = pawns.length ? storedNutrition / (pawns.length * 0.8) : 99;
  if (daysOfFood < 2) out.push({ key: 'food', severity: daysOfFood < 0.7 ? 'critical' : 'warning', title: 'Low food', detail: `About ${daysOfFood.toFixed(1)} days of food left.` });

  const f = m.factions.get(me);
  if (f && m.fireCells.size) {
    for (const c of m.fireCells) {
      const x = c % m.w;
      const y = Math.floor(c / m.w);
      if (Math.max(Math.abs(x - f.home.x), Math.abs(y - f.home.y)) <= 25) {
        out.push({ key: 'fire', severity: 'critical', title: 'Fire near your colony', detail: 'Make sure colonists have firefighting enabled.', focus: { x, y } });
        break;
      }
    }
  }

  // Winter warning in the last 3 days of fall.
  const cal = calendar(store.estTick());
  if (cal.season === 'Fall' && cal.dayOfSeason > DAYS_PER_SEASON - 3) {
    const daysLeft = DAYS_PER_SEASON - cal.dayOfSeason + (1 - cal.hour / 24);
    out.push({ key: 'winter', severity: 'warning', title: `Winter in ${daysLeft.toFixed(1)} days`, detail: 'Build heated rooms, stock food and harvest crops before they freeze.' });
  }

  // The frost line: the clock every colony is racing.
  if (f) {
    const days = daysUntilFrost(f.home.x, f.home.y, m.w, m.h, store.estTick(), m.frost, 8);
    if (days === 0) out.push({ key: 'frost', severity: 'critical', title: 'Your colony is in the frozen zone', detail: 'It will never warm up outside again. Keep rooms heated and wear parkas, or move inward (Orders → Move colony, then Pack up the old site).', focus: { x: f.home.x, y: f.home.y } });
    else if (days <= 8) out.push({ key: 'frost', severity: days <= 3 ? 'critical' : 'warning', title: `Frost line in ${days} day${days === 1 ? '' : 's'}`, detail: 'Permanent winter is closing in on your colony. Heat your rooms, make parkas, or move inward (Orders → Move colony).', focus: { x: f.home.x, y: f.home.y } });
  }

  const letters = m.choices.filter((c) => c.faction === me).length;
  if (letters) out.push({ key: 'letters', severity: 'info', title: `${letters} decision${letters > 1 ? 's' : ''} waiting`, detail: 'See the letters on the left.' });

  return out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/** Alerts the player waved away. One comes back if it clears and later recurs. */
const snoozed = new Set<string>();

export function Alerts() {
  useStore();
  const all = computeAlerts();
  for (const k of [...snoozed]) if (!all.some((a) => a.key === k)) snoozed.delete(k);
  const alerts = all.filter((a) => !snoozed.has(a.key));
  if (!alerts.length) return null;
  return (
    <div className="alerts" role="region" aria-label="Alerts">
      {alerts.slice(0, 10).map((a) => (
        <div key={a.key} className={`alert alert-row ${a.severity}`}>
          <button
            className="alert-body"
            title={a.focus ? `${a.detail} Click to show.` : a.detail}
            onClick={() => {
              if (a.focus) store.set({ focus: { x: a.focus.x, y: a.focus.y }, selected: a.focus.select ?? store.selected });
              if (a.trade) store.openTrade(a.trade);
              if (a.diplo) store.openDiplomacy(a.diplo);
            }}
          >
            <span>{a.title}</span>
            <small className="alert-detail">{a.detail}</small>
          </button>
          {a.severity !== 'critical' && (
            <button
              className="alert-close"
              aria-label={`Dismiss alert: ${a.title}`}
              title="Dismiss until it clears"
              onClick={() => {
                snoozed.add(a.key);
                store.emit();
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

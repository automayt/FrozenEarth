import { ANIMALS, APPAREL, BUILDINGS, CONDITIONS, LANDMARKS, type LandmarkKind, DOWNED_PAIN, ITEM_CATEGORIES, ITEMS, MAX_SKILL, maxHp, WEAPONS, PLANTS, RECIPES, ROCKS, SKILL_LABELS, SKILLS, SOWABLE_PLANTS, TERRAINS, TRAITS, weaponOf } from '@fe/defs';
import { bleedRate, bondOf, frostLevel, frostRadius, tameChance, CAVE_TEMP, describeJob, ROOF_SHELTER, dispositionOf, goodwillOf, outdoorTempAt, painOf, stageOf, TICKS_PER_HOUR, woundTotal, type Building, type Construct, type Entity, type Pawn, type Zone, constructCost, constructWork } from '@fe/sim';
import { helpers } from '../actions';
import { command } from '../net';
import { store, useStore } from '../store';
import { hex, pct } from './util';
import { SettlementCard } from './SettlementCard';
import { stealRisk } from './risk';

export function Inspect() {
  const s = useStore();
  const m = s.mirror;
  const e = s.selected ? m.get(s.selected) : undefined;
  const cell = s.selectedCell;
  if (!e && cell === null) return null;
  return (
    <div className="panel inspect">
      <button className="close" onClick={() => store.set({ selected: null, selectedCell: null, squad: [] })} aria-label="Close (Esc)" title="Close (Esc)">
        ×
      </button>
      {e ? <EntityInfo e={e} /> : null}
      {cell !== null && <CellInfo cell={cell} />}
    </div>
  );
}

function factionTag(id: number, brief = false) {
  const f = store.mirror.factions.get(id);
  if (!f) return null;
  return (
    <span className="faction">
      <i style={{ background: hex(f.color) }} />
      {f.name}
      {id === store.me?.faction ? ' (you)' : ''}
      {f.settlement && store.me?.faction && !brief ? <span className="muted"> · settlement, {f.settlement.state === 'fallen' ? 'abandoned' : `${dispositionOf(f.settlement, store.me.faction)} (goodwill ${goodwillOf(f.settlement, store.me.faction)})`}</span> : null}
    </span>
  );
}

function Bar({ label, v, warn = 0.25 }: { label: string; v: number; warn?: number }) {
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="meter">
        <div className={v < warn ? 'low' : ''} style={{ width: pct(v) }} />
      </div>
      <small>{pct(v)}</small>
    </div>
  );
}

function EntityInfo({ e }: { e: Entity }) {
  switch (e.kind) {
    case 'pawn':
      return e.species ? <AnimalInfo p={e} /> : <PawnInfo p={e} />;
    case 'building':
      if (BUILDINGS[e.def]?.landmark) return <LandmarkInfo b={e} />;
      return <BuildingInfo b={e} />;
    case 'construct':
      return <ConstructInfo c={e} />;
    case 'item': {
      const d = ITEMS[e.def];
      return (
        <>
          <h3>
            {d.label} ×{e.count}
          </h3>
          {WEAPONS[e.def] && <WeaponItem id={e.id} def={e.def} x={e.x} y={e.y} />}
          <StealItem id={e.id} x={e.x} y={e.y} />
          {d.spoilDays ? <p className="muted">Freshness {pct(1 - e.rot)} · spoils in about {Math.max(0, (1 - e.rot) * d.spoilDays).toFixed(1)} days at room temperature</p> : null}
        </>
      );
    }
    case 'plant': {
      const d = PLANTS[e.def];
      return (
        <>
          <h3>{d.label}</h3>
          <Bar label="Growth" v={e.growth} warn={0} />
          {e.blighted && <p className="bad">Blighted: it will die soon.</p>}
          {d.yieldItem && <p className="muted">Yields {ITEMS[d.yieldItem].label.toLowerCase()} when {d.tree ? 'cut' : 'harvested'}.</p>}
        </>
      );
    }
  }
}

/** Goods in someone else's stores: send a colonist to take them, now or after dark. */
function StealItem({ id, x, y }: { id: number; x: number; y: number }) {
  const m = store.mirror;
  const me = store.me?.faction;
  const z = m.zones.get(m.zoneAt[m.idx(x, y)]);
  const owner = z ? m.factions.get(z.faction) : undefined;
  if (!me || !z || z.kind !== 'stockpile' || z.faction === me || !owner || !(owner.isPlayer || (owner.settlement && owner.settlement.state !== 'fallen'))) return null;
  const who = helpers(x, y)[0];
  const lines = stealRisk(owner, x, y, who, true);
  // After dark, only what differs from stealing now.
  const dark = stealRisk(owner, x, y, who, false).filter((l) => !lines.some((n) => n.text === l.text));
  return (
    <>
    <div className="risk">
      <b className="small">Not yours: taking it is theft</b>
      <span className="muted small">Steal now:</span>
      {lines.map((l, i) => (
        <span key={i} className={`small ${l.tone}`}>
          {l.text}
        </span>
      ))}
      <span className="muted small">After dark:</span>
      {dark.map((l, i) => (
        <span key={`d${i}`} className={`small ${l.tone}`}>
          {l.text}
        </span>
      ))}
    </div>
    <div className="combat-row">
      <button disabled={!who} onClick={() => who && command({ c: 'steal', pawn: who.id, item: id })} title={who ? `Send ${who.name} to carry it off now` : 'No colonist free to go'}>
        {who ? `Steal (${who.name.split(' ')[0]})` : 'Steal'}
      </button>
      <button onClick={() => command({ c: 'designate', kind: 'steal', x0: x, y0: y, x1: x, y1: y })} title="Mark it: haulers sneak in after dark">
        After dark
      </button>
    </div>
    </>
  );
}

/** Stats of a loose weapon, and who should pick it up. */
function WeaponItem({ id, def, x, y }: { id: number; def: string; x: number; y: number }) {
  const wd = weaponOf(def);
  const who = helpers(x, y);
  return (
    <>
      <p className="muted small">
        {wd.melee ? 'Melee' : `Ranged, ${wd.range} cells`} · damage {Math.round(wd.damage * 100)} · every {(wd.cooldown / 60).toFixed(1)}s
      </p>
      {who.length > 0 && (
        <div className="combat-row">
          <span className="muted small">Equip</span>
          <select value="" onChange={(ev) => ev.target.value && command({ c: 'equip', pawn: Number(ev.target.value), item: id })}>
            <option value="">choose a colonist…</option>
            {who.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({weaponOf(p.weapon).label.toLowerCase()})
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

/** Whether any colonist can hunt: hunting needs a ranged weapon. */
function hasHunter(): boolean {
  for (const e of store.mirror.entities.values()) if (e.kind === 'pawn' && e.faction === store.me?.faction && !e.prisoner && !e.downed && e.weapon && !weaponOf(e.weapon).melee) return true;
  return false;
}

/** A place out in the wilds: what it is, whether it's been searched, and a button to send someone. */
function LandmarkInfo({ b }: { b: Building }) {
  const def = LANDMARKS[b.def as LandmarkKind];
  const m = store.mirror;
  const me = store.me?.faction ?? 0;
  const f = m.factions.get(me);
  if (!def || (me && !f?.seen?.includes(b.id))) return null;
  const been = !!f?.visited?.includes(b.id);
  const emptied = !def.lasting && !!b.found;
  const by = b.found && b.found > 0 ? m.factions.get(b.found) : undefined;
  const status = def.lasting
    ? been
      ? 'Your people have been here.'
      : 'Nobody of yours has been here yet.'
    : b.found === -1
      ? 'Buried under the ice. Nothing can be had from it now.'
      : b.found
        ? b.found === me
          ? 'Your people searched it.'
          : `Picked clean by ${by?.name ?? 'someone else'}.`
        : 'Not yet searched. Whoever gets there first takes what is there.';
  const frost = frostLevel(b.x, b.y, m.w, m.h, frostRadius(store.estTick(), m.frost));
  const who = helpers(b.x, b.y)[0];
  const send = () => {
    if (!who) return;
    command({ c: 'draft', pawns: [who.id], on: true });
    command({ c: 'move', pawns: [who.id], x: b.x, y: Math.min(m.h - 1, b.y + 1) });
    store.toast(`${who.name.split(' ')[0]} is heading out to the ${def.label.toLowerCase()} (drafted: R sends them back to work).`, 'good');
  };
  return (
    <>
      <div className="kind">Landmark</div>
      <h3>{def.label}</h3>
      <p className="small">{def.blurb}</p>
      <p className={`small ${emptied ? 'muted' : been ? 'good' : ''}`}>{status}</p>
      {!def.lasting && !b.found && frost > 0 && <p className="bad small">The frost is closing on it: reach it before the ice does.</p>}
      {b.def === 'hot_spring' && <p className="muted small">Warms the air for about five cells round it, even inside the frost, and its water never freezes. Colonists who bathe here feel better.</p>}
      {b.def === 'monolith' && <p className="muted small">Touch it to learn of the places around it. Under an aurora it hums, and inspires whoever stands by it.</p>}
      {b.def === 'frozen_wreck' && !b.found && <p className="muted small">Breaking into the hold is risky: something may be living in there.</p>}
      {me && who && !emptied && (!been || def.lasting) ? (
        <div className="combat-row">
          <button onClick={send} title="Draft them and send them walking there">
            Send {who.name.split(' ')[0]}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Towns that gave you a job this pawn is part of (a wolf to kill, a bandit to deal with). */
function wantedBy(id: number): string | null {
  const me = store.me?.faction;
  for (const f of store.mirror.factions.values()) {
    const job = f.settlement?.contracts?.find((c) => c.faction === me && c.targets.includes(id));
    if (job) return `Wanted by ${f.name}: part of the job you took.`;
  }
  return null;
}

function AnimalInfo({ p }: { p: Pawn }) {
  const def = ANIMALS[p.species!];
  const me = store.me?.faction ?? 0;
  const marked = p.hunted === me;
  if (p.tamed) {
    const owner = store.mirror.factions.get(p.tamed);
    const ours = p.tamed === me;
    return (
      <>
        <div className="kind">{ours ? 'Your animal' : `${owner?.name ?? 'A colony'}'s animal`}</div>
        <h3>
          {p.name} <span className="muted small">{def?.label.toLowerCase()}</span>
        </h3>
        <p className="muted small">
          {def?.draft
            ? `Grazes near home. On a journey it carries ${def.pack} and can pull a sledge.`
            : def?.pack
              ? `Grazes near home. On a journey it carries ${def.pack}.`
              : 'Keeps the colony company. Colonists who spend time with it feel a little better.'}
        </p>
        <div className="combat-row">
          <span className="muted small">Health {pct(Math.max(0, 1 - woundTotal(p)))}</span>
          {p.downed && <span className="chip bad">Downed</span>}
        </div>
      </>
    );
  }
  const taming = p.taming === me;
  const tamers = me ? [...store.mirror.entities.values()].filter((e): e is Pawn => e.kind === 'pawn' && e.faction === me && !e.species && !e.prisoner && !e.downed && e.priorities.hunt > 0) : [];
  const social = Math.max(0, ...tamers.map((t) => t.skills?.social?.level ?? 0));
  return (
    <>
      <div className="kind">{def?.predator ? 'Wild animal · predator' : 'Wild animal'}</div>
      <h3>{def?.label ?? p.name}</h3>
      <p className="muted small">{def?.predator ? 'Predator. Hunts when hungry, and people once winter comes.' : def?.defends ? 'Turns on anyone who attacks it.' : 'Skittish: bolts when people come close.'}</p>
      {wantedBy(p.id) && <p className="small good">{wantedBy(p.id)}</p>}
      <div className="combat-row">
        <span className="muted small">Health {pct(Math.max(0, 1 - woundTotal(p)))}</span>
        {p.downed && <span className="chip bad">Downed</span>}
        {me ? (
          <button className={marked ? 'on' : ''} onClick={() => command({ c: 'hunt', pawns: [p.id], on: !marked })} title="Hunters with a bow or rifle will go after it">
            {marked ? 'Stop hunting' : 'Hunt'}
          </button>
        ) : null}
        {me && def?.tame ? (
          <button className={taming ? 'on' : ''} onClick={() => command({ c: 'tame', pawns: [p.id], on: !taming })} title="Colonists on Hunt work will try to win it over">
            {taming ? 'Stop taming' : 'Tame'}
          </button>
        ) : null}
      </div>
      {me && taming && (
        <p className={`small ${tamers.length ? '' : 'bad'}`}>
          {tamers.length ? `Being tamed: about ${Math.round(tameChance(def!, social) * 100)}% a try with your best hand.` : 'Nobody has Hunt work turned on, so nobody will go.'}
        </p>
      )}
      {me && marked && !hasHunter() && <p className="bad small">None of your colonists has a bow or rifle, so nobody can hunt it yet.</p>}
      {def && (
        <p className="small">
          A kill gives about {def.meat} meat{def.hide ? ` and ${def.hide} cloth from the hide` : ''}.
        </p>
      )}
    </>
  );
}

function PawnInfo({ p }: { p: Pawn }) {
  const lookup = (id: number) => store.mirror.get(id);
  const mine = p.faction === store.me?.faction;
  const fac = store.mirror.factions.get(p.faction);
  const raider = !!fac?.raid;
  const settler = !!fac?.settlement && fac.settlement.state !== 'fallen';
  const chief = raider && fac?.raid?.chief === p.id;
  const band = raider ? (fac?.raid?.camp !== undefined ? 'Bandit' : 'Raider') : '';
  const kind = mine ? (p.prisoner ? (p.captive?.chief ? 'Prisoner · a raider chief' : 'Prisoner') : 'Your colonist') : raider ? (chief ? `${band} chief` : band) : settler ? 'Settler' : fac?.isPlayer ? "Another player's colonist" : 'Stranger';
  const wanted = wantedBy(p.id);
  return (
    <>
      <div className={`kind ${raider ? 'bad' : ''}`}>{kind}</div>
      <h3>{p.name}</h3>
      {factionTag(p.faction, settler)}
      {settler && store.me?.faction && fac ? <SettlementCard f={fac} /> : null}
      <div className="combat-row">
        <span className="muted small">{weaponOf(p.weapon).label}</span>
        {p.downed && <span className="chip bad">Downed</span>}
        {p.drafted && <span className="chip drafted">Drafted</span>}
        {p.prisoner && <span className="chip">{p.prisoner === 'leaving' ? 'Released' : 'Prisoner'}</span>}
        {mine && !p.downed && !p.prisoner && p.weapon && (
          <button onClick={() => command({ c: 'equip', pawn: p.id, item: 0 })} title="Drop the weapon here">
            Drop
          </button>
        )}
        {mine && !p.downed && !p.prisoner && (
          <button className={p.drafted ? 'on' : ''} onClick={() => command({ c: 'draft', pawns: [p.id], on: !p.drafted })} title="Draft to give move and attack orders (R)">
            {p.drafted ? 'Undraft' : 'Draft'}
          </button>
        )}
        {mine && !p.downed && !p.prisoner && (
          <button className={p.possessed ? 'on' : ''} onClick={() => command({ c: 'possess', pawn: p.id, on: !p.possessed })} title="Steer them yourself: WASD to walk, C to sneak, E to take or drop, Esc to let go">
            {p.possessed ? 'Let go' : 'Take control'}
          </button>
        )}
        {mine && p.prisoner === 'held' && (
          <button onClick={() => command({ c: 'release', pawn: p.id })} title="Let them walk away">
            Release
          </button>
        )}
        {raider && p.downed && (
          <button onClick={() => command({ c: 'capture', pawns: helpers(p.x, p.y).map((h) => h.id), target: p.id })} title="Carry them to a free bed and hold them prisoner">
            Capture
          </button>
        )}
      </div>
      {mine && p.prisoner === 'held' && (
        <p className="muted small">
          Held prisoner. Content prisoners may come round to joining the colony.
          {p.captive?.offerAt ? ` ${p.captive.band} may send word about buying them back.` : ''}
        </p>
      )}
      {chief && <p className="small">Leads {fac?.name}. Bring them down and the rest will break; they carry the band's purse.</p>}
      {wanted && <p className="small good">{wanted}</p>}
      <p className="job">{describeJob(p.job, lookup)}</p>
      {mine && (
        <>
          <Bar label="Food" v={p.needs.food} />
          <Bar label="Rest" v={p.needs.rest} />
          <Bar label="Mood" v={p.needs.mood} warn={0.3} />
        </>
      )}
      {p.carrying && (
        <p className="muted">
          Carrying {p.carrying.count} {ITEMS[p.carrying.def]?.label.toLowerCase()}
        </p>
      )}
      {p.apparel.length > 0 && (
        <p className="muted small">
          Wearing {p.apparel.map((a) => APPAREL[a]?.label.toLowerCase() ?? a).join(', ')}
        </p>
      )}
      {mine && (
        <div className="skills">
          {SKILLS.map((k) => (
          <div key={k} className="skill" title={`${SKILL_LABELS[k]} level ${p.skills?.[k]?.level ?? 0} of ${MAX_SKILL}`}>
            <span>{SKILL_LABELS[k]}</span>
            <div className="meter">
              <div style={{ width: `${((p.skills?.[k]?.level ?? 0) / MAX_SKILL) * 100}%` }} />
            </div>
            <small>{p.skills?.[k]?.level ?? 0}</small>
          </div>
          ))}
        </div>
      )}
      {p.traits.length > 0 && (
        <div className="traits">
          {p.traits.map((t) => (
            <span key={t} className="chip" title={TRAITS[t]?.description}>
              {TRAITS[t]?.label ?? t}
            </span>
          ))}
        </div>
      )}
      {mine && !p.prisoner && <Bonds p={p} />}
      {p.conditions.length > 0 && (
        <div className="health">
          <h4>Health</h4>
          <Wounds p={p} />
          {p.conditions.map((c) => {
            const def = CONDITIONS[c.key];
            if (!def) return null;
            const st = stageOf(def, c.severity);
            const timed = !!def.hours;
            const tone = def.kind === 'buff' || (def.kind === 'mood' && (st.mood ?? 0) > 0) ? 'good' : 'bad';
            return (
              <div key={c.key} className={`condition ${tone}`} title={def.description}>
                <span>
                  {def.label}
                  {st.label ? ` (${st.label})` : ''}
                </span>
                {def.healPerDay ? (
                  <small>
                    {Math.round(c.severity * 100)}% · {def.bleed ? (c.tended !== undefined ? `tended (${Math.round(c.tended * 100)}%)` : 'bleeding') : 'healing'}
                  </small>
                ) : timed ? (
                  <small>{Math.max(0, Math.ceil((c.until - store.mirror.tick) / TICKS_PER_HOUR))}h left</small>
                ) : def.immunityPerDay ? (
                  <small>
                    severity {Math.round(c.severity * 100)}% · immunity {Math.round(c.immunity * 100)}%
                  </small>
                ) : (
                  <small>{Math.round(c.severity * 100)}%</small>
                )}
              </div>
            );
          })}
        </div>
      )}
      {p.thoughts.length > 0 && (
        <ul className="thoughts">
          {p.thoughts.map((t) => (
            <li key={t} className={t.includes('+') ? 'good' : 'bad'}>
              {t}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const BOND_LABEL = { lover: 'lover', friend: 'friend', rival: 'rival', '': '' } as const;

/** How they get on with the rest of the colony: lover and friends first, rivals last. */
function Bonds({ p }: { p: Pawn }) {
  const op = p.social?.op ?? {};
  const rows = Object.keys(op)
    .map((k) => {
      const q = store.mirror.get(Number(k));
      if (!q || q.kind !== 'pawn' || q.faction !== p.faction) return null;
      const bond = bondOf(p, q);
      return { q, bond, v: Math.round(op[Number(k)]) };
    })
    .filter((r): r is NonNullable<typeof r> => !!r)
    .sort((a, b) => (b.bond === 'lover' ? 1 : 0) - (a.bond === 'lover' ? 1 : 0) || b.v - a.v);
  if (!rows.length) return null;
  return (
    <div className="health bonds">
      <h4>Bonds</h4>
      {rows.map(({ q, bond, v }) => (
        <div
          key={q.id}
          className={`condition ${bond === 'rival' || v < -15 ? 'bad' : bond || v > 15 ? 'good' : ''}`}
          title={`What ${p.name.split(' ')[0]} thinks of ${q.name}: ${v > 0 ? '+' : ''}${v} of 100`}
        >
          <span>
            {q.name}
            {bond ? ` (${BOND_LABEL[bond]})` : ''}
          </span>
          <small>{v > 0 ? `+${v}` : v}</small>
        </div>
      ))}
    </div>
  );
}

/** Pain, bleeding and how close the wounds are to killing. Only shown when wounded. */
function Wounds({ p }: { p: Pawn }) {
  const total = woundTotal(p);
  const bleed = bleedRate(p);
  if (total <= 0 && !p.downed) return null;
  return (
    <>
      <Bar label="Wounds" v={1 - total} warn={0.4} />
      <p className="muted small">
        Pain {Math.round((painOf(p) / DOWNED_PAIN) * 100)}% of collapse
        {bleed > 0 ? (
          <span className="bad"> · losing {((bleed * 100) / 24).toFixed(1)}% blood an hour, needs a doctor</span>
        ) : (
          <span> · not bleeding</span>
        )}
      </p>
    </>
  );
}

function ConstructInfo({ c }: { c: Construct }) {
  const d = BUILDINGS[c.def];
  return (
    <>
      <h3>{d.label} (blueprint)</h3>
      {factionTag(c.faction)}
      {c.kit && <p className="small good">From a packed kit: quick to set up.</p>}
      {Object.entries(constructCost(c)).map(([k, n]) => (
        <p key={k} className="muted">
          {ITEMS[k].label}: {c.delivered[k] ?? 0} / {n}
        </p>
      ))}
      <Bar label="Built" v={c.progress / constructWork(c)} warn={0} />
    </>
  );
}

function BuildingInfo({ b }: { b: Building }) {
  const d = BUILDINGS[b.def];
  const mine = b.faction === store.me?.faction;
  const owner = b.owner ? store.mirror.get<Pawn>(b.owner) : undefined;
  const fac = store.mirror.factions.get(b.faction);
  const town = !mine && fac?.settlement && fac.settlement.state !== 'fallen' ? fac : undefined;
  return (
    <>
      <h3>{d.label}</h3>
      {factionTag(b.faction, !!town)}
      {b.hp < maxHp(b.def) && <Bar label="Condition" v={b.hp / maxHp(b.def)} warn={0.35} />}
      {d.bed && <p className="muted">{owner ? `Owned by ${owner.name}` : 'Unclaimed'}</p>}
      {d.heat ? <p className="muted">{d.heat > 0 ? 'Heats' : 'Cools'} an enclosed room toward {d.targetTemp}°C</p> : null}
      {d.recipes && mine && <Bills b={b} />}
      {town && store.me?.faction ? <SettlementCard f={town} /> : null}
    </>
  );
}

function Bills({ b }: { b: Building }) {
  const recipes = BUILDINGS[b.def].recipes ?? [];
  return (
    <div className="bills">
      <h4>Bills</h4>
      {b.bills.length === 0 && <p className="muted small">No bills. Add one to start production.</p>}
      {b.bills.map((bill) => (
        <div key={bill.id} className={`bill ${bill.suspended ? 'suspended' : ''}`}>
          <span>{RECIPES[bill.recipe].label}</span>
          <select value={bill.mode} onChange={(e) => command({ c: 'updateBill', bench: b.id, bill: bill.id, mode: e.target.value as 'count' })}>
            <option value="count">Do X times</option>
            <option value="until">Until you have X</option>
            <option value="forever">Forever</option>
          </select>
          {bill.mode !== 'forever' && (
            <input type="number" min={0} max={999} value={bill.target} onChange={(e) => command({ c: 'updateBill', bench: b.id, bill: bill.id, target: Number(e.target.value) })} />
          )}
          <button title="Pause or resume this bill" onClick={() => command({ c: 'updateBill', bench: b.id, bill: bill.id, suspended: !bill.suspended })}>
            {bill.suspended ? '▶' : '❚❚'}
          </button>
          <button title="Delete bill" onClick={() => command({ c: 'removeBill', bench: b.id, bill: bill.id })}>
            ×
          </button>
        </div>
      ))}
      <div className="add-bill">
        {recipes.map((r) => (
          <button key={r} onClick={() => command({ c: 'addBill', bench: b.id, recipe: r, mode: 'count', target: 5 })}>
            + {RECIPES[r].label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CellInfo({ cell }: { cell: number }) {
  const m = store.mirror;
  const rock = m.rock[cell];
  const room = m.roomAt[cell] ? m.rooms.get(m.roomAt[cell]) : undefined;
  const roof = m.roof[cell] ?? 0;
  const open = outdoorTempAt(store.estTick(), m.coldOffset, m.conditions);
  const temp = room ? room.temp : open + (CAVE_TEMP - open) * (ROOF_SHELTER[roof] ?? 0);
  const zone = m.zoneAt[cell] ? m.zones.get(m.zoneAt[cell]) : undefined;
  const t = TERRAINS[m.terrain[cell]];
  const where = room ? `indoors (${room.cells.length} cells)` : roof === 2 ? 'under overhead mountain' : roof === 1 ? 'under a rock roof' : 'outdoors';
  return (
    <div className="cell-info">
      <p className="muted small">
        {rock ? ROCKS[rock].label : t.label}
        {!rock && t.fertility > 0 ? ` · fertility ${Math.round(t.fertility * 100)}%` : ''} · {temp.toFixed(1)}°C {where}
      </p>
      {zone && <ZoneInfo z={zone} />}
    </div>
  );
}

function ZoneInfo({ z }: { z: Zone }) {
  const mine = z.faction === store.me?.faction;
  return (
    <div className="zone">
      <h4>
        {z.kind === 'grow' ? 'Growing zone' : 'Stockpile'} · {z.cells.length} cells
      </h4>
      {factionTag(z.faction)}
      {mine && z.kind === 'grow' && (
        <select value={z.plant} onChange={(e) => command({ c: 'zoneSettings', zone: z.id, plant: e.target.value })}>
          {SOWABLE_PLANTS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label} ({p.growDays} days)
            </option>
          ))}
        </select>
      )}
      {mine && z.kind === 'stockpile' && (
        <div className="allow">
          {ITEM_CATEGORIES.map((c) => (
            <label key={c.key}>
              <input
                type="checkbox"
                checked={z.allow.includes(c.key)}
                onChange={(e) =>
                  command({ c: 'zoneSettings', zone: z.id, allow: e.target.checked ? [...z.allow, c.key] : z.allow.filter((a) => a !== c.key) })
                }
              />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

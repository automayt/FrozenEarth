import { ITEMS } from '@fe/defs';
import { type Item, type Pawn } from '@fe/sim';
import { fog } from '../render/fog';
import { command } from '../net';
import { store, useStore } from '../store';

/** What E would do right now: drop the load, or pick up something here or next door (and whose it is). */
function interactLabel(p: Pawn): { text: string; steal: boolean } | null {
  if (p.carrying) return { text: 'drop', steal: false };
  const m = store.mirror;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = p.x + dx;
      const y = p.y + dy;
      if (!m.inBounds(x, y)) continue;
      const it = m.get<Item>(m.itemAt[m.idx(x, y)]);
      if (!it || it.kind !== 'item') continue;
      const z = m.zones.get(m.zoneAt[m.idx(x, y)]);
      const steal = !!z && z.kind === 'stockpile' && z.faction !== p.faction;
      return { text: `take ${ITEMS[it.def]?.label.toLowerCase() ?? 'item'}`, steal };
    }
  }
  return null;
}

/** The colonist you're steering: keys, sneaking, what you carry, and who can see you right now. */
export function ControlBar() {
  const s = useStore();
  const me = s.me?.faction;
  let p: Pawn | undefined;
  for (const e of s.mirror.entities.values()) if (e.kind === 'pawn' && e.faction === me && e.possessed) p = e;
  if (!p) return null;
  let watchers = 0;
  for (const o of store.mirror.entities.values()) {
    if (o.kind !== 'pawn' || o.faction === me || o.species || o.prisoner) continue;
    if (Math.abs(o.x - p.x) > 20 || Math.abs(o.y - p.y) > 20) continue;
    if (fog.sees(o, p)) watchers++;
  }
  const stolen = p.job?.type === 'control' && p.job.stolen;
  const e = interactLabel(p);
  return (
    <div className="panel control-bar" role="region" aria-label="Direct control">
      <span className="muted small">Steering</span>
      <b>{p.name.split(' ')[0]}</b>
      <span className={`seen ${watchers ? 'bad' : 'good'}`} title="People who can see this colonist right now (rings show their sight)">
        {watchers ? `Seen by ${watchers}` : 'Unseen'}
      </span>
      {p.carrying && (
        <span className={stolen ? 'bad' : ''}>
          {stolen ? 'Stolen: ' : 'Carrying '}
          {p.carrying.count} {ITEMS[p.carrying.def]?.label.toLowerCase()}
        </span>
      )}
      <span className="keys-inline">
        <kbd>WASD</kbd> walk
      </span>
      <button className={p.sneaking ? 'on' : ''} onClick={() => command({ c: 'sneak', pawn: p.id, on: !p.sneaking })} title="Walk slowly and quietly (C)" aria-pressed={!!p.sneaking}>
        {p.sneaking ? 'Sneaking' : 'Sneak'} <kbd>C</kbd>
      </button>
      <button disabled={!e} onClick={() => command({ c: 'interact', pawn: p.id })} title={e ? (e.steal ? 'This belongs to someone else: taking it is theft' : 'Take or drop (E)') : 'Nothing here to take'}>
        {e ? (e.steal ? `Steal: ${e.text.replace('take ', '')}` : e.text[0].toUpperCase() + e.text.slice(1)) : 'Take'} <kbd>E</kbd>
      </button>
      <span className="muted small" title="Higher stealth means quieter steps and harder to spot">
        stealth {p.skills.stealth?.level ?? 0}
      </span>
      <button onClick={() => command({ c: 'possess', pawn: p.id, on: false })} title="Stop steering (Esc)">
        Let go <kbd>Esc</kbd>
      </button>
    </div>
  );
}

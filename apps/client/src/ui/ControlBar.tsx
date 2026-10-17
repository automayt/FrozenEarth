import { ITEMS } from '@fe/defs';
import { type Pawn } from '@fe/sim';
import { fog } from '../render/fog';
import { command } from '../net';
import { store, useStore } from '../store';

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
  return (
    <div className="panel control-bar">
      <b>{p.name.split(' ')[0]}</b>
      <span className={watchers ? 'bad' : 'good'}>{watchers ? `Seen by ${watchers}` : 'Unseen'}</span>
      {p.carrying && (
        <span className={stolen ? 'bad' : ''}>
          {stolen ? 'Stolen: ' : 'Carrying '}
          {p.carrying.count} {ITEMS[p.carrying.def]?.label.toLowerCase()}
        </span>
      )}
      <button className={p.sneaking ? 'on' : ''} onClick={() => command({ c: 'sneak', pawn: p.id, on: !p.sneaking })} title="C: walk slowly and quietly">
        Sneak <small>C</small>
      </button>
      <span className="muted small">WASD walk · E take/drop · stealth {p.skills.stealth?.level ?? 0}</span>
      <button onClick={() => command({ c: 'possess', pawn: p.id, on: false })} title="Esc">
        Let go <small>Esc</small>
      </button>
    </div>
  );
}

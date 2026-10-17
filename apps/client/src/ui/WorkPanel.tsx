import { WORK_LABELS, WORK_TYPES, type SkillKey, type WorkType } from '@fe/defs';

const WORK_SKILL: Partial<Record<WorkType, SkillKey>> = {
  construct: 'construction',
  mine: 'mining',
  grow: 'plants',
  plantcut: 'plants',
  cook: 'cooking',
  craft: 'crafting',
};
import type { Pawn } from '@fe/sim';
import { command } from '../net';
import { store, useStore } from '../store';

export function myPawns(): Pawn[] {
  const out: Pawn[] = [];
  for (const e of store.mirror.entities.values()) if (e.kind === 'pawn' && e.faction === store.me?.faction && !e.prisoner) out.push(e);
  return out.sort((a, b) => a.id - b.id);
}

/** Priority grid: 1 is most important, blank means never. Click cycles. */
export function WorkPanel() {
  useStore();
  const pawns = myPawns();
  return (
    <div className="panel work-panel">
      <button className="close" onClick={() => store.set({ panel: 'none' })} aria-label="Close (Esc)" title="Close (Esc)">
        ×
      </button>
      <h3>Work priorities</h3>
      <p className="muted small">1 = do first, 4 = do last, blank = never. Click to cycle, right-click to go back.</p>
      <table>
        <thead>
          <tr>
            <th />
            {WORK_TYPES.map((w) => (
              <th key={w}>{WORK_LABELS[w]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pawns.map((p) => (
            <tr key={p.id}>
              <td className="name" onClick={() => store.set({ selected: p.id, focus: { x: p.x, y: p.y } })}>
                {p.name}
              </td>
              {WORK_TYPES.map((w) => {
                const v = p.priorities[w];
                const skill = WORK_SKILL[w];
                const level = skill ? (p.skills?.[skill]?.level ?? 0) : null;
                const next = v === 0 ? 1 : v === 4 ? 0 : v + 1;
                const prev = v === 0 ? 4 : v === 1 ? 0 : v - 1;
                return (
                  <td key={w}>
                    <button
                      title={level !== null ? `Skill level ${level}` : undefined}
                      className={`prio p${v}`}
                      onClick={() => command({ c: 'setPriority', pawn: p.id, work: w, prio: next })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        command({ c: 'setPriority', pawn: p.id, work: w, prio: prev });
                      }}
                    >
                      {v || ''}
                      {level !== null && <sub className={level >= 10 ? 'skilled' : ''}>{level}</sub>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

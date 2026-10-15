import { WORK_LABELS, WORK_TYPES } from '@fe/defs';
import type { Pawn } from '@fe/sim';
import { command } from '../net';
import { store, useStore } from '../store';

export function myPawns(): Pawn[] {
  const out: Pawn[] = [];
  for (const e of store.mirror.entities.values()) if (e.kind === 'pawn' && e.faction === store.me?.faction) out.push(e);
  return out.sort((a, b) => a.id - b.id);
}

/** Priority grid: 1 is most important, blank means never. Click cycles. */
export function WorkPanel() {
  useStore();
  const pawns = myPawns();
  return (
    <div className="panel work-panel">
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
                const next = v === 0 ? 1 : v === 4 ? 0 : v + 1;
                const prev = v === 0 ? 4 : v === 1 ? 0 : v - 1;
                return (
                  <td key={w}>
                    <button
                      className={`prio p${v}`}
                      onClick={() => command({ c: 'setPriority', pawn: p.id, work: w, prio: next })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        command({ c: 'setPriority', pawn: p.id, work: w, prio: prev });
                      }}
                    >
                      {v || ''}
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

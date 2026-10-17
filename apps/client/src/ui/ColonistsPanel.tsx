import { CONDITIONS } from '@fe/defs';
import { describeJob, woundTotal, type Pawn } from '@fe/sim';
import { command } from '../net';
import { store, useStore } from '../store';
import { pct } from './util';
import { myPawns } from './WorkPanel';

/** The one thing most worth knowing about a colonist at a glance. */
function status(p: Pawn): { text: string; tone: string } {
  if (p.downed) return { text: 'Downed', tone: 'bad' };
  const mental = p.conditions.find((c) => CONDITIONS[c.key]?.kind === 'mental');
  if (mental) return { text: CONDITIONS[mental.key].label, tone: 'bad' };
  if (p.possessed) return { text: 'You steer', tone: 'warn' };
  if (p.drafted) return { text: 'Drafted', tone: 'warn' };
  const sick = p.conditions.find((c) => CONDITIONS[c.key]?.kind === 'disease' || (CONDITIONS[c.key]?.lethal && c.severity >= 0.3));
  if (sick) return { text: CONDITIONS[sick.key].label, tone: 'bad' };
  return { text: '', tone: '' };
}

export function ColonistsPanel() {
  const s = useStore();
  const lookup = (id: number) => store.mirror.get(id);
  const pick = (p: Pawn) => store.set({ selected: p.id, squad: [p.id], selectedCell: null, focus: { x: p.x, y: p.y } });
  return (
    <div className="panel colonists-panel">
      <button className="close" onClick={() => store.set({ panel: 'none' })} aria-label="Close (Esc)" title="Close (Esc)">
        ×
      </button>
      <h3>Colonists</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Doing</th>
            <th>Health</th>
            <th>Food</th>
            <th>Rest</th>
            <th>Mood</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {myPawns().map((p) => {
            const st = status(p);
            const health = Math.max(0, 1 - woundTotal(p));
            return (
              <tr key={p.id} className={s.selected === p.id ? 'selected' : ''} onClick={() => pick(p)}>
                <td className="name">
                  <button className="link" onClick={() => pick(p)} title="Select and show">
                    {p.name}
                  </button>
                </td>
                <td className={st.tone}>{st.text}</td>
                <td className="muted">{describeJob(p.job, lookup)}</td>
                <td className={health < 0.6 ? 'bad' : ''}>{pct(health)}</td>
                <td className={p.needs.food < 0.25 ? 'bad' : ''}>{pct(p.needs.food)}</td>
                <td className={p.needs.rest < 0.25 ? 'bad' : ''}>{pct(p.needs.rest)}</td>
                <td className={p.needs.mood < 0.3 ? 'bad' : ''}>{pct(p.needs.mood)}</td>
                <td>
                  {!p.downed && (
                    <button
                      className={p.drafted ? 'on' : ''}
                      onClick={(e) => {
                        e.stopPropagation();
                        command({ c: 'draft', pawns: [p.id], on: !p.drafted });
                      }}
                    >
                      {p.drafted ? 'Undraft' : 'Draft'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

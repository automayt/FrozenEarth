import { describeJob } from '@fe/sim';
import { store, useStore } from '../store';
import { pct } from './util';
import { myPawns } from './WorkPanel';

export function ColonistsPanel() {
  useStore();
  const lookup = (id: number) => store.mirror.get(id);
  return (
    <div className="panel colonists-panel">
      <h3>Colonists</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Doing</th>
            <th>Food</th>
            <th>Rest</th>
            <th>Mood</th>
          </tr>
        </thead>
        <tbody>
          {myPawns().map((p) => (
            <tr key={p.id} onClick={() => store.set({ selected: p.id, focus: { x: p.x, y: p.y } })}>
              <td className="name">{p.name}</td>
              <td className="muted">{describeJob(p.job, lookup)}</td>
              <td className={p.needs.food < 0.25 ? 'bad' : ''}>{pct(p.needs.food)}</td>
              <td className={p.needs.rest < 0.25 ? 'bad' : ''}>{pct(p.needs.rest)}</td>
              <td className={p.needs.mood < 0.3 ? 'bad' : ''}>{pct(p.needs.mood)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

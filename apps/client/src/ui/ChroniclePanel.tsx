import { calendar, MILESTONES } from '@fe/sim';
import { store, useStore } from '../store';
import { Icon } from './Icon';

/** Your colony's story: milestones (reached, and still ahead) and the moments worth retelling. */
export function ChroniclePanel() {
  const s = useStore();
  const f = s.mirror.factions.get(s.me?.faction ?? 0);
  const close = (
    <button className="close" onClick={() => store.set({ panel: 'none' })} aria-label="Close (Esc)" title="Close (Esc)">
      ×
    </button>
  );
  if (!f) return null;
  const tales = [...(f.chronicle ?? [])].reverse();
  const reached = new Set(f.milestones ?? []);
  return (
    <div className="panel trade-panel chronicle-panel" role="dialog" aria-label={`The story of ${f.name}`}>
      {close}
      <h3>The story of {f.name}</h3>
      <ul className="milestones" aria-label="Milestones">
        {Object.entries(MILESTONES).map(([key, label]) => (
          <li key={key} className={reached.has(key) ? 'reached' : ''} title={reached.has(key) ? 'Reached' : 'Still ahead'}>
            <Icon name="events" size={14} />
            {label}
          </li>
        ))}
      </ul>
      {tales.length ? (
        <ol className="tales">
          {tales.map((t, i) => {
            const cal = calendar(t.tick);
            return (
              <li key={`${t.tick}-${i}`} className={t.milestone ? 'milestone' : ''}>
                <span className="tale-day">
                  {cal.season} {cal.dayOfSeason}, year {cal.year}
                </span>
                <span className="tale-text">{t.text}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted">Nothing worth retelling yet. The story fills in as things happen: a first trade, a raid driven off, a winter lived through.</p>
      )}
    </div>
  );
}

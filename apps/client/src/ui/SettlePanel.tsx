import { send } from '../net';
import { store, useStore } from '../store';

/** Shown to a new player before their colony exists. */
export function SettlePanel() {
  const s = useStore();
  const pick = s.settlePick;
  return (
    <div className="panel settle">
      <h3>Choose where to settle</h3>
      <p className="muted">
        The <b>outer band</b> is gentle now but freezes first. The <b>middle lands</b> and the <b>center</b> are harsher, but winter
        reaches them last. Click anywhere on the map to pick a spot. Other colonies need room around them (shaded circles).
      </p>
      <p className="muted small">
        The map at the top right shows the frost line closing in and the settlements: <span className="good">green</span> trade gladly, <span style={{ color: 'var(--amber)' }}>amber</span> are wary, <span className="bad">red</span> attack anyone who comes close.
      </p>
      <div className="sites">
        {s.sites.map((site, i) => (
          <button
            key={i}
            className={pick && pick.x === site.x && pick.y === site.y ? 'on' : ''}
            onClick={() => store.set({ settlePick: { x: site.x, y: site.y }, focus: { x: site.x, y: site.y } })}
          >
            Site {i + 1}
            <small>{site.region}</small>
          </button>
        ))}
      </div>
      <div className="settle-actions">
        <button className="primary" disabled={!pick} onClick={() => pick && send({ t: 'settle', x: pick.x, y: pick.y })}>
          {pick ? `Settle at ${pick.x}, ${pick.y}` : 'Pick a spot'}
        </button>
        <button onClick={() => send({ t: 'settle' })}>Let fate decide</button>
      </div>
    </div>
  );
}

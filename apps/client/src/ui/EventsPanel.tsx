import { EVENTS, type EventCategory, type Rarity } from '@fe/defs';
import { send } from '../net';
import { store, useStore } from '../store';

const CATEGORIES: EventCategory[] = ['weather', 'health', 'mood', 'fortune', 'disaster', 'visitors', 'threat', 'mystery'];
const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'unique'];

/** Host-only tool: fire any event right now, targeting your own colony. */
export function EventsPanel() {
  useStore();
  const byCat = (cat: EventCategory) =>
    Object.values(EVENTS)
      .filter((e) => e.category === cat)
      .sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity) || a.label.localeCompare(b.label));
  return (
    <div className="panel events-panel">
      <button className="close" onClick={() => store.set({ panel: 'none' })} aria-label="Close (Esc)" title="Close (Esc)">
        ×
      </button>
      <h3>Trigger an event</h3>
      <p className="muted small">Host tool for testing. Colony events target your own colony. Map events hit everyone.</p>
      <div className="event-grid">
        {CATEGORIES.map((cat) => (
          <div key={cat}>
            <h4>{cat}</h4>
            {byCat(cat).map((e) => (
              <button key={e.key} className={`event-btn ${e.tone} r-${e.rarity}`} title={e.description} onClick={() => send({ t: 'admin', action: 'event', key: e.key })}>
                <span>{e.label}</span>
                <small>
                  {e.rarity}
                  {e.followUp ? ' · follow-up' : ''}
                </small>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

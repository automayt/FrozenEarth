import { store, useStore } from '../store';

/** Answers to the player's own actions: refusals and results, shown briefly near the top of the screen. */
export function Toasts() {
  const s = useStore();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {s.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.at ? (
            <button className="toast-text" onClick={() => store.set({ focus: t.at! })} title="Show on map">
              {t.text}
            </button>
          ) : (
            <span className="toast-text">{t.text}</span>
          )}
          <button className="toast-close" onClick={() => store.dismissToast(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

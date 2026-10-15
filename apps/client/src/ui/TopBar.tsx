import { calendar, outdoorTempAt, TICKS_PER_HOUR } from '@fe/sim';
import { EVENTS } from '@fe/defs';
import { myPlayer, setSpeed } from '../actions';
import { useStore } from '../store';
import { hex } from './util';

export function TopBar() {
  const s = useStore();
  const m = s.mirror;
  const tick = s.estTick();
  const cal = calendar(tick);
  const temp = outdoorTempAt(tick, m.coldOffset, m.conditions);
  const me = myPlayer();
  const vote = me?.speed ?? 1;
  return (
    <div className="topbar panel">
      <div className="clock">
        <div className="date">{cal.label}</div>
        <div className={`temp ${temp < 0 ? 'cold' : temp > 30 ? 'hot' : ''}`}>{temp.toFixed(1)}°C outdoors</div>
      </div>
      <div className="conditions">
        {m.conditions.map((c, i) => (
          <span key={i} className={`chip ${EVENTS[c.key]?.tone ?? ''}`} title={`${EVENTS[c.key]?.description ?? ''} Ends in ${Math.max(0, Math.ceil((c.until - tick) / TICKS_PER_HOUR))}h.`}>
            {EVENTS[c.key]?.label ?? c.key}
          </span>
        ))}
      </div>
      <div className="speed">
        {[0, 1, 2, 3].map((v) => (
          <button key={v} className={vote === v ? 'on' : ''} onClick={() => setSpeed(v)} title={v === 0 ? 'Request pause (Space)' : `Speed ${v} (${v})`}>
            {v === 0 ? '❚❚' : '▶'.repeat(v)}
          </button>
        ))}
        <div className="speed-state">
          {s.time.paused ? <b>Paused</b> : <b>{s.time.speed}×</b>}
          <span className="muted"> {s.time.reason}</span>
          {me && s.players.filter((p) => p.connected).length > 1 && <span className="muted"> · {me.pauseBudget}s pause left</span>}
        </div>
      </div>
      <div className="players">
        {s.players
          .filter((p) => p.connected || p.id === s.me?.playerId)
          .map((p) => (
            <span key={p.id} className="player" title={`${p.name}${p.admin ? ' (host)' : ''} · votes ${p.speed === 0 ? 'pause' : p.speed + '×'}`}>
              <i style={{ background: hex(p.color) }} />
              {p.name}
              <small>{p.speed === 0 ? '❚❚' : `${p.speed}×`}</small>
            </span>
          ))}
        {s.players.some((p) => !p.connected) && (
          <span
            className="player offline"
            title={s.players
              .filter((p) => !p.connected)
              .map((p) => p.name)
              .join(', ')}
          >
            {s.players.filter((p) => !p.connected).length} offline
          </span>
        )}
        <span className="muted small">{s.ping} ms</span>
      </div>
    </div>
  );
}

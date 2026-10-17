import { useEffect, useRef } from 'react';
import { calendar, daysUntilFrost, frostRadius, outdoorTempAt, TICKS_PER_HOUR } from '@fe/sim';
import { EVENTS } from '@fe/defs';
import { myPlayer, setSpeed } from '../actions';
import { store, useStore } from '../store';
import { hex } from './util';
import { SoundControl } from './SoundControl';

/**
 * When the top bar wraps onto a second row (narrow window, a long pause reason, a weather chip),
 * everything hung under it moves down by the extra height instead of hiding beneath it.
 */
function useWrapOffset() {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef('');
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    // One row is as tall as the clock's two lines plus the bar's padding and border.
    const cs = getComputedStyle(el);
    const frame = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const one = ((el.querySelector('.clock') as HTMLElement | null)?.offsetHeight ?? 36) + frame;
    const extra = el.offsetHeight - one;
    const v = `${extra > 8 ? Math.round(extra) : 0}px`;
    if (v === last.current) return;
    last.current = v;
    document.documentElement.style.setProperty('--topbar-extra', v);
  };
  // After every render (the pause reason or a weather chip can change the width) and on resize.
  useEffect(measure);
  useEffect(() => {
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ref.current) ro?.observe(ref.current);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      document.documentElement.style.removeProperty('--topbar-extra');
      last.current = '';
    };
  }, []);
  return ref;
}

export function TopBar() {
  const s = useStore();
  const m = s.mirror;
  const tick = s.estTick();
  const cal = calendar(tick);
  const temp = outdoorTempAt(tick, m.coldOffset, m.conditions);
  const me = myPlayer();
  const vote = me?.speed ?? 1;
  // Running slower than you asked: someone else's vote is holding the game back.
  const held = !s.time.paused && vote > s.time.speed;
  const slow = held ? s.players.filter((p) => p.connected && p.id !== me?.id && p.speed === s.time.speed) : [];
  const heldBy = (slow.some((p) => !p.away) ? slow.filter((p) => !p.away) : slow).map((p) => p.name);
  const bar = useWrapOffset();
  return (
    <div className="topbar panel" ref={bar}>
      <div className="clock">
        <div className="date">{cal.label}</div>
        <div className="temp-row">
          <span className={`temp ${temp < 0 ? 'cold' : temp > 30 ? 'hot' : ''}`}>{temp.toFixed(1)}°C outdoors</span>
          <FrostChip />
        </div>
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
          <button
            key={v}
            className={vote === v ? 'on' : held && v === s.time.speed ? 'held' : ''}
            onClick={() => setSpeed(v)}
            title={v === 0 ? 'Request pause (Space)' : held && v === s.time.speed ? `Running at ${v}×: ${heldBy.join(', ')} asked for it` : `Speed ${v} (${v})`}
          >
            {v === 0 ? '❚❚' : '▶'.repeat(v)}
          </button>
        ))}
        <div className="speed-state" title={`${s.time.paused ? 'Paused' : `${s.time.speed}×`} ${s.time.reason}`.trim()}>
          {s.time.paused ? <b>Paused</b> : <b>{s.time.speed}×</b>}
          {held ? <span className="held-by"> held by {heldBy.join(', ')}</span> : <span className="muted"> {s.time.reason}</span>}
          {me && s.players.filter((p) => p.connected).length > 1 && <span className="muted"> · {me.pauseBudget}s pause left</span>}
        </div>
      </div>
      <div className="players">
        {s.players
          .filter((p) => p.connected || p.id === s.me?.playerId)
          .map((p) => (
            <span
              key={p.id}
              className={`player ${p.away ? 'away' : ''}`}
              title={`${p.name}${p.admin ? ' (host)' : ''} · votes ${p.speed === 0 ? 'pause' : p.speed + '×'}${p.away ? ' · away (tab in the background), so their speed vote is ignored' : ''}`}
            >
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
        <SoundControl />
        <button className="help-btn" onClick={() => store.set({ help: !s.help })} title="Controls and how-tos (?)" aria-label="Help">
          ?
        </button>
        <span className="muted small ping">{s.ping} ms</span>
      </div>
    </div>
  );
}

/** Days until the frost line reaches your colony: the clock the whole game runs on. Click to see the line nearest you. */
function FrostChip() {
  const s = store;
  const m = s.mirror;
  const f = s.me?.faction ? m.factions.get(s.me.faction) : undefined;
  if (!f || !m.w) return null;
  const tick = s.estTick();
  const days = daysUntilFrost(f.home.x, f.home.y, m.w, m.h, tick, m.frost, 60);
  const label = days === 0 ? 'Past the frost line' : days === Infinity ? 'Frost 60+ days off' : `Frost in ${days} day${days === 1 ? '' : 's'}`;
  const short = days === 0 ? 'frozen' : days === Infinity ? '60+d' : `${days}d`;
  const tone = days <= 3 ? 'bad' : days <= 8 ? 'warn' : '';
  const show = () => {
    // The point of the line on the way from the map centre out through your colony.
    const half = Math.min(m.w, m.h) / 2;
    const cx = m.w / 2;
    const cy = m.h / 2;
    const d = Math.hypot(f.home.x - cx, f.home.y - cy) || 1;
    const r = Math.min(frostRadius(tick, m.frost) * half, Math.hypot(cx, cy));
    const x = Math.max(0, Math.min(m.w - 1, Math.round(cx + ((f.home.x - cx) / d) * r)));
    const y = Math.max(0, Math.min(m.h - 1, Math.round(cy + ((f.home.y - cy) / d) * r)));
    s.set({ focus: { x, y } });
  };
  return (
    <button
      className={`frost-chip ${tone}`}
      onClick={show}
      aria-label={label}
      title={
        days === 0
          ? 'Your colony is past the frost line: it will never be warm outside again. Heat your rooms and wear parkas, or move inward (Orders → Move colony). Click to see the line.'
          : 'Permanent winter creeps in from the map edge toward the centre. When it gets close, dig in (heaters, parkas, food) or move your colony inward: Orders → Move colony, then Pack up the old site. Click to see the frost line nearest you.'
      }
    >
      ❄ <span className="fc-long">{label}</span>
      <span className="fc-short">{short}</span>
    </button>
  );
}

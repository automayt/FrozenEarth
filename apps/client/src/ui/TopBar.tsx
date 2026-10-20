import { calendar, daysUntilFrost, frostRadius, outdoorTempAt, pactOf, TICKS_PER_HOUR } from '@fe/sim';
import { EVENTS } from '@fe/defs';
import { myPlayer, setSpeed } from '../actions';
import { store, useStore } from '../store';
import { hex } from './util';
import { SoundControl } from './SoundControl';
import { Icon } from './Icon';

/** Players, then the speed clasp: who's here, and how fast the shared clock runs. Top right. */
export function TopBar() {
  const s = useStore();
  const m = s.mirror;
  const me = myPlayer();
  const vote = me?.speed ?? 1;
  // Running slower than you asked: someone else's vote is holding the game back.
  const held = !s.time.paused && vote > s.time.speed;
  const slow = held ? s.players.filter((p) => p.connected && p.id !== me?.id && p.speed === s.time.speed) : [];
  const heldBy = (slow.some((p) => !p.away) ? slow.filter((p) => !p.away) : slow).map((p) => p.name);
  // Who is holding the pause, and how long their budget lets them.
  const pausers = s.time.paused ? s.players.filter((p) => p.connected && p.speed === 0) : [];
  const pauseText = pausers.map((p) => (p.id === me?.id ? `you (${p.pauseBudget}s left)` : `${p.name} (${p.pauseBudget}s left)`)).join(', ');
  const online = s.players.filter((p) => p.connected).length;
  const offline = s.players.filter((p) => !p.connected);
  const speedIcon = ['pause', 'play', 'fast', 'faster'];
  return (
    <>
      <FrostDial />
      <div className="clasp" role="region" aria-label="Players and game speed">
        <div className="pennants">
          {s.players
            .filter((p) => p.connected || p.id === s.me?.playerId)
            .map((p) => {
              const f = p.faction ? m.factions.get(p.faction) : undefined;
              const mine = p.id === me?.id;
              const pact = !mine && me?.faction && p.faction ? pactOf(m, me.faction, p.faction)?.kind : undefined;
              const stance = pact === 'ally' ? 'ally' : pact === 'war' ? 'at war' : pact === 'truce' ? 'truce' : '';
              return (
                <button
                  key={p.id}
                  className={`pennant ${p.away ? 'away' : ''} ${pact ?? ''} ${mine ? 'mine' : ''}`}
                  style={{ ['--flag' as string]: hex(p.color) }}
                  disabled={!f}
                  onClick={() => f && store.set({ focus: { x: f.home.x, y: f.home.y } })}
                  title={`${p.name}${mine ? ' (you)' : ''}${p.admin ? ' (host)' : ''}${f ? `, ${f.name}` : ', choosing where to settle'}${stance ? `, ${stance}` : ''}. Votes ${p.speed === 0 ? 'pause' : p.speed + '×'}${p.away ? ' (away: tab in the background, so the vote is ignored)' : ''}.${f ? ' Click to show their colony.' : ''}`}
                >
                  <span className="pennant-name">{p.name}</span>
                  {stance && <em className="stance-tag">{stance}</em>}
                  <small className="pennant-vote">{p.speed === 0 ? '❚❚' : `${p.speed}×`}</small>
                </button>
              );
            })}
          {offline.length > 0 && (
            <span className="pennant offline" title={offline.map((p) => p.name).join(', ')}>
              {offline.length} offline
            </span>
          )}
        </div>
        <div className="speed-plate panel">
          <div className="speed" role="group" aria-label="Game speed">
            {[0, 1, 2, 3].map((v) => (
              <button
                key={v}
                className={vote === v ? 'on' : held && v === s.time.speed ? 'held' : ''}
                onClick={() => setSpeed(v)}
                aria-label={v === 0 ? 'Pause' : `Speed ${v}`}
                aria-pressed={vote === v}
                title={v === 0 ? 'Request pause (Space)' : held && v === s.time.speed ? `Running at ${v}×: ${heldBy.join(', ')} asked for it` : `Speed ${v} (${v})`}
              >
                <Icon name={speedIcon[v]} size={18} />
              </button>
            ))}
          </div>
          <SoundControl />
          <button className="icon-btn help-btn" onClick={() => store.set({ help: !s.help })} title="Controls and how-tos (?)" aria-label="Help">
            <Icon name="help" size={18} />
          </button>
          <div className="speed-state" title={`${s.time.paused ? 'Paused' : `${s.time.speed}×`} ${s.time.reason}`.trim()}>
            {s.time.paused ? <b>Paused</b> : <b>{s.time.speed}×</b>}
            {held ? (
              <span className="held-by"> held by {heldBy.join(', ')}</span>
            ) : pausers.length && online > 1 ? (
              <span className="held-by"> by {pauseText}</span>
            ) : (
              <span className="muted"> {s.time.paused && pausers.length ? '' : s.time.reason}</span>
            )}
            {me && online > 1 && !pausers.some((p) => p.id === me.id) && <span className="muted">, {pausers.length ? `you have ${me.pauseBudget}s` : `${me.pauseBudget}s of pause left`}</span>}
            <span className="ping muted" title="Round trip to the server">
              {' '}
              {s.ping} ms
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The frost dial: the season and day in the middle, the outdoor temperature beneath, and a ring
 * the ice creeps round as the frost line closes on your colony (full ring: it's here).
 */
function FrostDial() {
  const s = useStore();
  const m = s.mirror;
  const tick = s.estTick();
  const cal = calendar(tick);
  const temp = outdoorTempAt(tick, m.coldOffset, m.conditions);
  const f = s.me?.faction ? m.factions.get(s.me.faction) : undefined;
  const days = f && m.w ? daysUntilFrost(f.home.x, f.home.y, m.w, m.h, tick, m.frost, 60) : Infinity;
  const ice = days === 0 ? 1 : days === Infinity ? 0 : 1 - days / 60;
  const R = 47;
  const C = 2 * Math.PI * R;
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  const time = `${String(Math.floor(cal.hour)).padStart(2, '0')}:${String(Math.floor((cal.hour % 1) * 60)).padStart(2, '0')}`;
  const tone = days <= 3 ? 'bad' : days <= 8 ? 'warn' : '';
  const frostSay = days === Infinity ? 'frost over 60 days off' : days === 0 ? 'past the frost line' : `frost in ${days} days`;
  return (
    <div className="dial-wrap">
      <div className={`dial ${tone}`} role="img" aria-label={`${cal.label}, ${temp.toFixed(0)}°C outdoors, ${frostSay}`}>
        <svg viewBox="0 0 120 120" width="112" height="112" aria-hidden="true">
          <defs>
            <radialGradient id="dial-felt" cx="50%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#273046" />
              <stop offset="100%" stopColor="#151a26" />
            </radialGradient>
            <linearGradient id="dial-brass" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e8c983" />
              <stop offset="55%" stopColor="#a8833f" />
              <stop offset="100%" stopColor="#6b5124" />
            </linearGradient>
          </defs>
          <circle cx="60" cy="60" r="57" fill="url(#dial-brass)" />
          <circle cx="60" cy="60" r="53.5" fill="#0f131b" />
          <circle cx="60" cy="60" r="52" fill="url(#dial-felt)" />
          {ticks.map((i) => {
            const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
            const r1 = i % 5 === 0 ? 43 : 46;
            return <line key={i} x1={60 + Math.cos(a) * r1} y1={60 + Math.sin(a) * r1} x2={60 + Math.cos(a) * 50} y2={60 + Math.sin(a) * 50} className={i / 60 < ice ? 'tick iced' : 'tick'} />;
          })}
          {ice > 0 && <circle className="ice-arc" cx="60" cy="60" r={R} fill="none" strokeDasharray={`${C * ice} ${C}`} transform="rotate(-90 60 60)" />}
        </svg>
        <div className="dial-face">
          <span className="dial-season">{cal.season}</span>
          <span className="dial-day">{cal.dayOfSeason}</span>
          <span className="dial-time">{time}</span>
          <span className={`dial-temp ${temp < 0 ? 'cold' : temp > 30 ? 'hot' : ''}`}>{temp.toFixed(0)}°</span>
        </div>
      </div>
      <div className="dial-notes">
        <FrostChip />
        {m.conditions.map((c, i) => (
          <span key={i} className={`chip ${EVENTS[c.key]?.tone ?? ''}`} title={`${EVENTS[c.key]?.description ?? ''} Ends in ${Math.max(0, Math.ceil((c.until - tick) / TICKS_PER_HOUR))}h.`}>
            {EVENTS[c.key]?.label ?? c.key}
          </span>
        ))}
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
      <Icon name="frost" size={14} />
      <span className="fc-long">{label}</span>
      <span className="fc-short">{short}</span>
    </button>
  );
}

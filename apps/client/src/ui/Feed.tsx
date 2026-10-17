import { useEffect, useRef, useState } from 'react';
import { calendar, TICKS_PER_HOUR, type GameMessage } from '@fe/sim';
import { command, send } from '../net';
import { store, useStore } from '../store';
import { hex } from './util';
import { Checklist } from './Checklist';
import { Hints } from './Hints';

/** Letters the player closed this session. Keyed by tick and text, which is unique enough. */
const dismissed = new Set<string>();
const letterKey = (x: GameMessage) => `${x.tick}:${x.text}`;
const SHOWN = 6;

/** Event letters and chat in one column on the left. */
export function Feed() {
  const s = useStore();
  const m = s.mirror;
  const [text, setText] = useState('');
  const [log, setLog] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const all = m.messages.filter((x) => x.faction === 0 || x.faction === s.me?.faction);
  // Replies to our own commands already popped up as toasts; the letters are for news.
  const msgs = all.filter((x) => !x.reply && !dismissed.has(letterKey(x))).slice(-SHOWN);
  const jump = (x: GameMessage) => x.at !== undefined && store.set({ focus: { x: x.at % m.w, y: Math.floor(x.at / m.w) } });
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'end' });
  }, [s.chat.length]);
  return (
    <div className="feed">
      <div className="letters">
        <Hints />
        <Checklist />
        {m.choices
          .filter((c) => c.faction === s.me?.faction)
          .map((c) => {
            const hours = Math.max(0, Math.ceil((c.expires - m.tick) / TICKS_PER_HOUR));
            const fallback = c.options[c.options.length - 1];
            return (
              <div key={c.id} className="letter choice" role="group" aria-label={c.title}>
                <div className="choice-head">
                  <b>{c.title}</b>
                  {c.at !== undefined && (
                    <button className="link" onClick={() => store.set({ focus: { x: c.at! % m.w, y: Math.floor(c.at! / m.w) } })}>
                      Show
                    </button>
                  )}
                </div>
                <p>{c.text}</p>
                <div className="options">
                  {c.options.map((o, i) => (
                    <button key={o.key} className={i === 0 ? 'on' : ''} onClick={() => command({ c: 'choose', choice: c.id, option: o.key })}>
                      {o.label}
                    </button>
                  ))}
                </div>
                <small className={hours <= 2 ? 'bad' : ''}>
                  {hours}h to decide{fallback && c.options.length > 1 ? `, then: ${fallback.label.toLowerCase()}` : ''}
                </small>
              </div>
            );
          })}
        {msgs.map((x) => (
          <div key={letterKey(x)} className={`letter letter-row ${x.tone}`}>
            <button className="letter-body" onClick={() => jump(x)} disabled={x.at === undefined} title={x.at !== undefined ? 'Show on map' : undefined}>
              <small>
                {calendar(x.tick).label.split(' · ')[0]}
                {x.at !== undefined && <span className="jump"> · show ›</span>}
              </small>
              {x.text}
            </button>
            <button
              className="letter-close"
              aria-label="Dismiss letter"
              title="Dismiss"
              onClick={() => {
                dismissed.add(letterKey(x));
                store.emit();
              }}
            >
              ×
            </button>
          </div>
        ))}
        {all.length > 0 && (
          <div className="letter-tools">
            {msgs.length > 1 && (
              <button
                className="link muted"
                onClick={() => {
                  for (const x of all) dismissed.add(letterKey(x));
                  store.emit();
                }}
              >
                Clear letters
              </button>
            )}
            <button className="link muted" onClick={() => setLog(!log)} aria-expanded={log}>
              {log ? 'Hide log' : `Log (${all.length})`}
            </button>
          </div>
        )}
        {log && (
          <div className="panel letter-log">
            {all
              .slice(-60)
              .reverse()
              .map((x, i) => (
                <button key={i} className={`log-line ${x.tone}`} onClick={() => jump(x)} disabled={x.at === undefined}>
                  <small>{calendar(x.tick).label.split(' · ')[0]}</small> {x.text}
                </button>
              ))}
          </div>
        )}
      </div>
      <div className="panel chat">
        <div className="lines">
          {s.chat.slice(-40).map((c, i) => (
            <div key={i} className={c.from ? '' : 'system'}>
              {c.from && <b style={{ color: hex(c.color) }}>{c.from}: </b>}
              {c.text}
            </div>
          ))}
          <div ref={chatEnd} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send({ t: 'chat', text });
            setText('');
            // Back to the game after sending, so WASD pans again.
            (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.blur();
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Chat with other players… (Enter)" maxLength={300} aria-label="Chat" />
        </form>
      </div>
    </div>
  );
}

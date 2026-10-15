import { useEffect, useRef, useState } from 'react';
import { calendar } from '@fe/sim';
import { send } from '../net';
import { store, useStore } from '../store';
import { hex } from './util';

/** Event letters and chat in one column on the left. */
export function Feed() {
  const s = useStore();
  const m = s.mirror;
  const [text, setText] = useState('');
  const chatEnd = useRef<HTMLDivElement>(null);
  const msgs = m.messages.filter((x) => x.faction === 0 || x.faction === s.me?.faction).slice(-8);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'end' });
  }, [s.chat.length]);
  return (
    <div className="feed">
      <div className="letters">
        {msgs.map((x, i) => (
          <button
            key={`${x.tick}-${i}`}
            className={`letter ${x.tone}`}
            onClick={() => x.at !== undefined && store.set({ focus: { x: x.at % m.w, y: Math.floor(x.at / m.w) } })}
            title={x.at !== undefined ? 'Click to jump there' : undefined}
          >
            <small>{calendar(x.tick).label.split(' · ')[0]}</small>
            {x.text}
          </button>
        ))}
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
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Chat with other players…" maxLength={300} />
        </form>
      </div>
    </div>
  );
}

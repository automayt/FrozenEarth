import { useEffect, useRef, useState } from 'react';
import { MILESTONES, type GameMessage } from '@fe/sim';
import { sound } from '../audio';
import { store, useStore } from '../store';

/**
 * The few moments that deserve to stop you for a second: raiders at the door, an alliance sworn,
 * war declared, the caravan home. A banner across the top with a sound; click it to look.
 */

interface Moment {
  key: number;
  title: string;
  text: string;
  tone: 'good' | 'bad' | 'neutral';
  at?: number;
}

/** Which letters become moments, and what the banner says. First match wins. */
const RULES: { test: RegExp; title: string; tone: Moment['tone'] }[] = [
  { test: /spring an ambush/, title: 'Ambush!', tone: 'bad' },
  { test: /(have arrived from the|creeping in from the|have come from the .* with picks)/, title: 'Raiders!', tone: 'bad' },
  { test: /scouting party/, title: 'Scouts on the edge', tone: 'bad' },
  { test: /(declared war on|without warning\. They are at war)/, title: 'War', tone: 'bad' },
  { test: /(are now allies|is now your ally)/, title: 'An alliance is sworn', tone: 'good' },
  { test: /have made peace/, title: 'Peace', tone: 'good' },
  { test: /caravan has arrived/, title: 'Home at last', tone: 'good' },
  { test: /(has joined your colony|joins your colony)/, title: 'A new colonist', tone: 'good' },
  { test: /The frost line has reached your colony/, title: 'The frost is here', tone: 'bad' },
  { test: /has fallen\. Whatever they had/, title: 'A town has fallen', tone: 'neutral' },
];

const SHOW_MS = 4200;

export function Moments() {
  const s = useStore();
  const me = s.me?.faction ?? 0;
  const seen = useRef(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [moment, setMoment] = useState<Moment | null>(null);
  const total = s.mirror.messagesTotal;
  useEffect(() => {
    const msgs = s.mirror.messages;
    // Joining replays old letters: start from here, so only what happens from now on is a moment.
    if (seen.current < 0 || total < seen.current) {
      seen.current = total;
      return;
    }
    const fresh = msgs.slice(Math.max(0, msgs.length - (total - seen.current)));
    seen.current = total;
    let found: Moment | null = null;
    fresh.forEach((x: GameMessage, i) => {
      if (x.reply || (x.faction !== 0 && x.faction !== me)) return;
      const rule = RULES.find((r) => r.test.test(x.text));
      if (rule) found = { key: total * 100 + i, title: rule.title, text: x.text, tone: rule.tone, at: x.at };
    });
    if (!found) return;
    const shown: Moment = found;
    setMoment(shown);
    sound.play(shown.tone === 'good' ? 'good' : shown.tone === 'bad' ? 'bad' : 'neutral');
    // Its own timer: later letters arriving mustn't keep it on screen.
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoment((m) => (m?.key === shown.key ? null : m)), SHOW_MS);
  }, [total, me]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // A milestone reached: the colony's story gets a new chapter.
  const reached = s.mirror.factions.get(me)?.milestones ?? [];
  const known = useRef<number>(-1);
  useEffect(() => {
    if (known.current < 0 || reached.length < known.current) {
      known.current = reached.length;
      return;
    }
    if (reached.length === known.current) return;
    const key = reached[reached.length - 1];
    known.current = reached.length;
    const shown: Moment = { key: -reached.length, title: MILESTONES[key] ?? 'A milestone', text: "A new line in your colony's story. Open it with J.", tone: 'good' };
    setMoment(shown);
    sound.play('good');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoment((m) => (m?.key === shown.key ? null : m)), SHOW_MS);
  }, [reached.length, me]);
  if (!moment) return null;
  const at = moment.at;
  return (
    <button
      key={moment.key}
      className={`moment ${moment.tone}`}
      onClick={() => {
        if (at !== undefined) store.set({ focus: { x: at % s.mirror.w, y: Math.floor(at / s.mirror.w) } });
        else if (moment.key < 0) store.set({ panel: 'chronicle' });
        setMoment(null);
      }}
      title={at !== undefined ? 'Show on the map' : 'Dismiss'}
    >
      <span className="moment-title">{moment.title}</span>
      <span className="moment-text">{moment.text}</span>
    </button>
  );
}

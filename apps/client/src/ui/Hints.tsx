import { useState } from 'react';
import { daysUntilFrost, type Faction, type Pawn } from '@fe/sim';
import { store, useStore } from '../store';
import { toggleDraft } from '../actions';

interface Hint {
  key: string;
  title: string;
  text: string;
  action?: { label: string; run: () => void };
}

const SEEN_KEY = 'fe.hints.seen';
const OFF_KEY = 'fe.hints.off';

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: tips come back next time, which is harmless.
  }
}

function seenSet(): Set<string> {
  try {
    return new Set(JSON.parse(load(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Tips that apply right now, most urgent first. Each is shown once, at the moment it matters. */
function current(): Hint[] {
  const m = store.mirror;
  const me = store.me?.faction;
  if (!me) return [];
  const mine: Pawn[] = [];
  for (const e of m.entities.values()) if (e.kind === 'pawn' && e.faction === me && !e.prisoner) mine.push(e);
  const out: Hint[] = [];
  const raid = [...m.factions.values()].find((f) => f.raid && !f.raid.fled && f.raid.target === me);
  if (raid) {
    out.push({
      key: 'raid',
      title: 'Raiders are coming',
      text: 'Draft your colonists (R), then right-click to put them behind sandbags or embrasures (build them from the Defense menu). Right-click a raider to attack. The alert on the right says what the raiders are up to.',
      action: mine.some((p) => p.drafted) ? undefined : { label: 'Draft', run: toggleDraft },
    });
  }
  const steering = mine.find((p) => p.possessed);
  if (steering) {
    out.push({
      key: 'control',
      title: `You're steering ${steering.name.split(' ')[0]}`,
      text: 'WASD walks, C sneaks, E picks up or drops what is underfoot, Esc lets go. Rings around people show how far they see; red means they can see you now. The bar at the top says whether you are seen.',
    });
  }
  if (mine.some((p) => p.drafted)) {
    out.push({
      key: 'drafted',
      title: 'Drafted colonists wait for orders',
      text: 'They stop working. Right-click the ground to move them, someone else to attack, goods in a foreign stockpile to steal, or a weapon to pick it up. Press R again to send them back to work.',
    });
  }
  const f = m.factions.get(me);
  if (f) {
    const days = daysUntilFrost(f.home.x, f.home.y, m.w, m.h, store.estTick(), m.frost, 8);
    if (days <= 8) {
      out.push({
        key: 'frost',
        title: 'The frost line is near',
        text: "Permanent winter will reach your colony. You can dig in (heaters, parkas, food stores) or move: pick a new home further in, then pack up the old site so haulers carry it all over.",
        action: { label: 'Move colony…', run: () => store.set({ tool: { kind: 'moveHome' }, selected: null }) },
      });
    }
  }
  const asked = [...m.factions.values()].find((s) => s.settlement?.requests?.some((r) => r.faction === me));
  if (asked) {
    out.push({
      key: 'request',
      title: `You promised to help ${asked.name}`,
      text: 'Gather the goods in your stockpiles, walk a colonist over to them, then press Deliver in the Trade panel. The alert on the right counts down the time left.',
      action: { label: 'Open Trade', run: () => store.openTrade(asked.id) },
    });
  }
  if (m.choices.some((c) => c.faction === me)) {
    out.push({
      key: 'choice',
      title: 'A letter needs your decision',
      text: 'Pick one of its options. If time runs out, the last option is chosen for you.',
    });
  }
  const met: Faction | undefined = [...m.factions.values()].find((s) => s.settlement && s.settlement.state !== 'fallen' && s.settlement.met.includes(me));
  if (met) {
    out.push({
      key: 'settlement',
      title: `You've met ${met.name}`,
      text: 'Settlements trade when one of your colonists is near them (Trade panel, T). Gifts raise their goodwill; the ring around the town shows their mood. Their stockpiles can be stolen from too (Orders → Steal), but getting caught makes enemies.',
      action: { label: 'Open Trade', run: () => store.openTrade(met.id) },
    });
  }
  if (m.tick > 0) {
    out.push({
      key: 'welcome',
      title: 'Welcome to your colony',
      text: 'Pan with WASD or a right-drag, zoom with the wheel, click a colonist to see what they can do. The checklist below walks you through the first days. Press ? for every control.',
      action: { label: 'Show controls', run: () => store.set({ help: true }) },
    });
  }
  return out;
}

/** One contextual tip at a time, in the letters column. */
export function Hints() {
  useStore();
  const [seen, setSeen] = useState(seenSet);
  const [off, setOff] = useState(() => load(OFF_KEY) === '1');
  if (off) return null;
  const hint = current().find((h) => !seen.has(h.key));
  if (!hint) return null;
  const dismiss = () => {
    const next = new Set(seen).add(hint.key);
    setSeen(next);
    save(SEEN_KEY, JSON.stringify([...next]));
  };
  return (
    <div className="panel hint" role="note">
      <div className="hint-head">
        <b>{hint.title}</b>
        <button
          className="link muted"
          onClick={() => {
            setOff(true);
            save(OFF_KEY, '1');
          }}
          title="Stop showing tips (the ? help stays available)"
        >
          No more tips
        </button>
      </div>
      <p>{hint.text}</p>
      <div className="hint-actions">
        {hint.action && (
          <button
            className="on"
            onClick={() => {
              hint.action!.run();
              dismiss();
            }}
          >
            {hint.action.label}
          </button>
        )}
        <button onClick={dismiss}>Got it</button>
      </div>
    </div>
  );
}

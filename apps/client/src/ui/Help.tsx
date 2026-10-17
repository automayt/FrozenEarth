import { useEffect, useRef } from 'react';
import { store, useStore } from '../store';

const KEYS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Camera',
    rows: [
      ['W A S D / arrows', 'Pan'],
      ['Right or middle drag', 'Pan'],
      ['Mouse wheel', 'Zoom'],
      ['H', 'Jump to your colony'],
      ['F', 'Jump to the selection'],
    ],
  },
  {
    title: 'Time',
    rows: [
      ['Space', 'Pause / resume (a vote, in multiplayer)'],
      ['1  2  3', 'Speed'],
    ],
  },
  {
    title: 'Selecting and orders',
    rows: [
      ['Click', 'Select what is under the cursor'],
      ['Drag', 'Box-select your colonists'],
      ['R', 'Draft or undraft the selection (everyone, if none)'],
      ['Right-click', 'Drafted: move, attack, capture, steal, pick up a weapon'],
      ['Right-click', 'Otherwise: put the tool away, or deselect'],
      ['Esc', 'Close the topmost thing: help, tool, menu, panel, selection'],
    ],
  },
  {
    title: 'Menus',
    rows: [
      ['O  Z  B', 'Orders, Zones, Build (Structure)'],
      ['P  L  T', 'Work priorities, Colonist list, Trade'],
      ['Enter', 'Chat'],
      ['M', 'Mute sound'],
      ['?  or  F1', 'This help'],
    ],
  },
  {
    title: 'Steering a colonist (Inspect → Take control)',
    rows: [
      ['W A S D / arrows', 'Walk (the camera follows)'],
      ['C', 'Sneak: slow and quiet'],
      ['E', 'Take or drop what is underfoot'],
      ['Esc', 'Let go'],
    ],
  },
];

const HOWTO: [string, string][] = [
  ['The frost', 'Permanent winter creeps inward from the map edge. Alerts count down the days. When it gets close: Orders → Move colony (click a new site further in), then Orders → Pack up the old one so haulers bring everything over.'],
  ['Settlements', 'Towns of non-player people. Open Trade (T), pick the town, and send a colonist within range: the panel says who is there. Gifts (give, ask for nothing) raise goodwill. Towns sometimes ask for help in a letter: accept, gather the goods, then Deliver from the Trade panel.'],
  ['Stealing', 'Orders → Steal, then drag over goods in a town or colony stockpile: haulers sneak in after dark. Or draft a colonist and right-click the goods to send them now. Anyone awake who sees it raises the alarm, and goodwill drops.'],
  ['Hunting', 'Select an animal and press Hunt, or Orders → Hunt and drag over animals. Colonists with a bow or rifle bring them down for meat and hides. Predators bite back.'],
  ['Stealth', 'When you steer a colonist, rings show what nearby watchers can see. Stay out of sight, sneak (C) to be quiet, and work at night. The control bar says whether you are seen.'],
  ['Raids and cover', 'Alerts on the right say what raiders are doing. Defense → Sandbags and Embrasures give cover; draft colonists (R) and right-click to put them behind it. Raiders who give up on your walls go looting instead.'],
];

/** Keyboard shortcuts and short how-tos for the less obvious systems. */
export function Help() {
  const s = useStore();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (s.help) box.current?.focus();
  }, [s.help]);
  if (!s.help) return null;
  const close = () => store.set({ help: false });
  return (
    <div className="help-backdrop" onClick={close}>
      <div className="panel help" role="dialog" aria-modal="true" aria-label="Help" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={close} aria-label="Close help">
          ×
        </button>
        <h3>How to play</h3>
        <div className="help-cols">
          <div>
            {KEYS.map((g) => (
              <section key={g.title}>
                <h4>{g.title}</h4>
                <table className="keys">
                  <tbody>
                    {g.rows.map(([k, what], i) => (
                      <tr key={i}>
                        <td>
                          <kbd>{k}</kbd>
                        </td>
                        <td>{what}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
          <div>
            {HOWTO.map(([title, text]) => (
              <section key={title}>
                <h4>{title}</h4>
                <p>{text}</p>
              </section>
            ))}
          </div>
        </div>
        <p className="muted small">Press ? any time to open this again. Esc closes it.</p>
      </div>
    </div>
  );
}

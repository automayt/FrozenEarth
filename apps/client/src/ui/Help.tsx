import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../store';
import { myPlayer, setSpeed } from '../actions';
import { rejoinCode } from '../net';

/**
 * Pausing for help. Speed is shared and, with others online, every second paused comes out of a
 * daily pause budget. So help pauses the game only when you are the only one online (where
 * pausing is free and stops nobody), and resumes it on close. With others online the game keeps
 * running and the overlay says so, offering an explicit pause that spends your budget.
 */
let resumeTo: number | null = null;

function onlineCount(): number {
  return store.players.filter((p) => p.connected).length;
}

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
      ['P  L  T  G', 'Work priorities, Colonist list, Trade, Diplomacy'],
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
  ['Playing with friends', "Game speed is the slowest vote among players with the game in front of them (a background tab doesn't count); hover a name at the top to see who votes what. Each player has a daily pause budget. Click a name to jump to their colony. Offers from other players (trade, alliance, peace) wait while you're offline, and when you come back the letters you missed are listed on the left. Allies see what each other's colonists see and walk through each other's doors."],
  ['The frost', 'Permanent winter creeps inward from the map edge; the ❄ chip at the top counts the days until it reaches you. To move inward: Orders → Move colony and hover the map (it shows how long each spot stays warm), click the new site, then Orders → Pack up the old one so haulers carry everything over.'],
  ['Settlements', 'Walled towns of non-player people; the ring around each is their land, coloured by their mood toward you. Click any of their people or buildings for goodwill, prices, what they want and what they have. To trade, open Trade (T) and get a colonist within 14 cells. Towns that know you sometimes ask for help in a letter: agree, gather the goods, then Deliver from the Trade panel.'],
  ['Diplomacy', 'Open Diplomacy (G) to see where every town and colony stands, with you and with each other, and why. Towns that like you enough (goodwill 60) will swear an alliance: they send fighters when you are raided. A hostile town takes tribute for a truce. Rival towns resent whoever helps the other side; a colonist with good Social skill can talk them into peace. Other players: propose an alliance or peace (they get a letter), or declare war. Attacking a colony without declaring war starts one anyway, and the towns hear of it.'],
  ['Goodwill', 'Runs from -100 to 100. At -40 or below a town turns hostile and its guards attack your colonists near their land; at 30 or above they are friends. Gifts, fair trades and kept promises raise it. Getting caught stealing (-45), attacking their people and broken promises lower it. Hover a risky order to see the exact change.'],
  ['Stealing', 'Orders → Steal, then drag over goods in a town or colony stockpile: haulers sneak in after dark (you need a stockpile of your own to carry it to). Or draft a colonist and right-click the goods to go now. Hovering shows who can see that spot and what getting caught would cost. Fires light the ground around them, even at night.'],
  ['Hunting', 'Select an animal and press Hunt, or Orders → Hunt and drag over animals. Colonists with a bow or rifle bring them down for meat and hides; make bows at a workbench. Predators bite back, and wolves come for people once winter sets in.'],
  ['Stealth', 'Select a colonist and press Take control to steer them yourself. Rings show what nearby watchers can see; red means they see you now. Sneak (C) to be slow, quiet and harder to spot, stay out of lit areas, and work at night. The bar at the top says whether you are seen.'],
  ['Raids and cover', 'Alerts on the right say what raiders are doing. Defense → Sandbags (low cover you can shoot over) and Embrasures (walls with a firing slit) protect whoever stands right behind them. Draft colonists (R) and right-click to put them there before the raiders arrive. Raiders who give up on your walls go looting instead.'],
];

/** Keyboard shortcuts and short how-tos for the less obvious systems. */
export function Help() {
  const s = useStore();
  const box = useRef<HTMLDivElement>(null);
  const online = onlineCount();
  useEffect(() => {
    if (s.help) box.current?.focus();
  }, [s.help]);
  useEffect(() => {
    const me = myPlayer();
    if (s.help && online <= 1 && resumeTo === null && me && me.speed !== 0) {
      resumeTo = me.speed;
      setSpeed(0);
    } else if (resumeTo !== null && (!s.help || online > 1)) {
      // Closed, or someone joined (their arrival would start charging the pause to us): resume.
      if (myPlayer()?.speed === 0) setSpeed(resumeTo);
      resumeTo = null;
    }
  }, [s.help, online]);
  if (!s.help) return null;
  const close = () => store.set({ help: false });
  const me = myPlayer();
  const others = online - 1;
  const status =
    resumeTo !== null ? (
      <p className="help-status">❚❚ Paused while you read (you're the only one online). Closing help resumes the game.</p>
    ) : others > 0 ? (
      <p className="help-status running">
        ▶ The game keeps running: {others} other player{others > 1 ? 's are' : ' is'} online.{' '}
        {me && me.speed !== 0 ? (
          <button className="link" onClick={() => setSpeed(0)} disabled={me.pauseBudget <= 0}>
            {me.pauseBudget > 0 ? `Pause (uses your pause time, ${me.pauseBudget}s left)` : 'No pause time left today'}
          </button>
        ) : (
          <span>You are holding it paused ({me?.pauseBudget ?? 0}s of pause time left).</span>
        )}
      </p>
    ) : null;
  return (
    <div className="help-backdrop" onClick={close}>
      <div className="panel help" role="dialog" aria-modal="true" aria-label="Help" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={close} aria-label="Close help">
          ×
        </button>
        <h3>How to play</h3>
        {status}
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
        <AnotherDevice />
        <p className="muted small">Press ? any time to open this again. Esc closes it.</p>
      </div>
    </div>
  );
}

/** The rejoin code: the only way to reach your colony from a second device or browser. */
function AnotherDevice() {
  const me = myPlayer();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const code = me ? rejoinCode(me.name) : null;
  if (!me || !code) return null;
  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => setShown(true),
    );
  };
  return (
    <section className="rejoin">
      <h4>Play on another device</h4>
      <p className="small">
        On the join screen of the other device, enter <b>{me.name}</b> and this rejoin code. Keep it to yourself: anyone with it can play your colony.
      </p>
      <div className="rejoin-row">
        <code>{shown ? code : '•'.repeat(12)}</code>
        <button onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}</button>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Frost } from './Frost';

const TIPS = [
  'The frost only moves one way. Plan your walk inward before it reaches the door.',
  'Fires light the ground around them, even at night. Thieves stay out of the light.',
  'Heaters only warm enclosed rooms. A gap in the wall is a gap in the heat.',
  'Pack up the old site before you move: beds and benches fold into kits you can carry.',
  'Draft colonists with R, then right-click to put them behind sandbags before raiders arrive.',
  'A tamed muskox pulls a sledge on its own. A deer carries 45.',
  'Towns that like you enough will swear an alliance and send fighters when you are raided.',
  'Hot springs stay warm in the frost.',
  "Getting caught stealing costs 45 goodwill. Hover the goods first to see who's watching.",
  'Parkas are made at a tailor bench. Winter nights kill.',
  'Hover a name at the top of the screen to see who is voting for what speed.',
  'Select a colonist and press Take control to walk them yourself. Sneak with C.',
  'Walk someone up to a landmark to search it. Richer finds lie further in.',
  'A colonist with good Social skill can talk rival towns into peace.',
];

/** The world behind this screen is loading; it lifts as soon as the first frame is drawn. */
export function LoadingScreen() {
  const s = useStore();
  const ready = s.worldReady;
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (ready) {
      const t = setTimeout(() => setGone(true), 520);
      return () => clearTimeout(t);
    }
    setGone(false);
    const t = setInterval(() => setTip((n) => (n + 1) % TIPS.length), 7000);
    return () => clearInterval(t);
  }, [ready]);
  if (gone) return null;
  const R = 34;
  return (
    <div className={`loading-screen ${ready ? 'lifting' : ''}`} role="status" aria-label="Loading the world">
      <div className="loading-art" />
      <Frost reach={0.16} creep={5} />
      <div className="loading-foot">
        <svg className="loading-ring" viewBox="0 0 80 80" width="64" height="64" aria-hidden="true">
          <circle cx="40" cy="40" r="38" fill="none" stroke="#a8833f" strokeWidth="2.5" />
          <circle cx="40" cy="40" r={R} fill="#151a26" stroke="#0f131b" strokeWidth="2" />
          <circle className="loading-ice" cx="40" cy="40" r={R} fill="none" pathLength={100} strokeDasharray="100" transform="rotate(-90 40 40)" />
        </svg>
        <div>
          <h2>{s.me?.faction ? 'Waking the colony' : 'Scouting the land'}</h2>
          <p key={tip} className="tip-line">
            {TIPS[tip]}
          </p>
        </div>
      </div>
    </div>
  );
}

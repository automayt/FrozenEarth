import { useEffect, useRef } from 'react';
import { GameRenderer } from '../render/renderer';
import { store, useStore } from '../store';
import { JoinScreen } from './JoinScreen';
import { TopBar } from './TopBar';
import { Architect } from './Architect';
import { Inspect } from './Inspect';
import { Feed } from './Feed';
import { WorkPanel } from './WorkPanel';
import { ColonistsPanel } from './ColonistsPanel';
import { EventsPanel } from './EventsPanel';
import { Alerts } from './Alerts';
import { SettlePanel } from './SettlePanel';

export function App() {
  const s = useStore();
  const playing = s.status === 'playing' || (s.status === 'connecting' && s.me !== null);
  return (
    <>
      {playing && <GameView />}
      {playing && s.me?.faction === 0 ? (
        <div className="hud">
          <TopBar />
          <Feed />
          <SettlePanel />
        </div>
      ) : playing ? (
        <div className="hud">
          <TopBar />
          {s.status === 'connecting' && <div className="banner">{s.error || 'Reconnecting…'}</div>}
          <Feed />
          <Alerts />
          <Inspect />
          {s.panel === 'work' && <WorkPanel />}
          {s.panel === 'colonists' && <ColonistsPanel />}
          {s.panel === 'events' && <EventsPanel />}
          <Architect />
        </div>
      ) : (
        <JoinScreen />
      )}
    </>
  );
}

function GameView() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = new GameRenderer();
    r.init(host.current!);
    if (import.meta.env.DEV) Object.assign(window, { __fe: { store, renderer: r } });
    return () => r.destroy();
  }, []);
  return <div className="game" ref={host} />;
}

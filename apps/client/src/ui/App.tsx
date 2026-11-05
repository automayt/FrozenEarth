import { useEffect, useRef } from 'react';
import { GameRenderer } from '../render/renderer';
import { store, useStore } from '../store';
import { command } from '../net';
import { JoinScreen } from './JoinScreen';
import { TopBar } from './TopBar';
import { Architect } from './Architect';
import { Inspect } from './Inspect';
import { Feed } from './Feed';
import { WorkPanel } from './WorkPanel';
import { ColonistsPanel } from './ColonistsPanel';
import { EventsPanel } from './EventsPanel';
import { Alerts } from './Alerts';
import { Minimap } from './Minimap';
import { SettlePanel } from './SettlePanel';
import { TradePanel } from './TradePanel';
import { DiplomacyPanel } from './DiplomacyPanel';
import { ControlBar } from './ControlBar';
import { Toasts } from './Toasts';
import { Help } from './Help';
import { OrderPreview } from './OrderPreview';
import { CaravanCard, JourneyPanel } from './JourneyPanel';
import { Moments } from './Moments';
import { ChroniclePanel } from './ChroniclePanel';
import { LoadingScreen } from './LoadingScreen';

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
          <Minimap />
          <SettlePanel />
          <Toasts />
          <Help />
        </div>
      ) : playing ? (
        <div className="hud">
          <TopBar />
          {s.status === 'connecting' && <div className="banner">{s.error || 'Reconnecting…'}</div>}
          <Feed />
          <Minimap />
          <Alerts />
          <Inspect />
          <ControlBar />
          <CaravanCard />
          <Moments />
          <JourneyPanel />
          {s.panel === 'work' && <WorkPanel />}
          {s.panel === 'colonists' && <ColonistsPanel />}
          {s.panel === 'events' && <EventsPanel />}
          {s.panel === 'trade' && <TradePanel />}
          {s.panel === 'diplomacy' && <DiplomacyPanel />}
          {s.panel === 'chronicle' && <ChroniclePanel />}
          <Architect />
          <OrderPreview />
          <Toasts />
          <Help />
        </div>
      ) : (
        <JoinScreen />
      )}
      {playing && <LoadingScreen />}
    </>
  );
}

function GameView() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = new GameRenderer();
    let live = true;
    // The first frames build the whole map; the loading screen lifts once they're on screen.
    const reveal = (frames: number) => {
      if (!live) return;
      if (frames > 0) requestAnimationFrame(() => reveal(frames - 1));
      else store.set({ worldReady: true });
    };
    r.init(host.current!).then(
      () => reveal(3),
      (e) => {
        console.error(e);
        store.set({ status: 'error', error: "This browser couldn't start the game's graphics." });
      },
    );
    if (import.meta.env.DEV) Object.assign(window, { __fe: { store, renderer: r, command } });
    return () => {
      live = false;
      store.worldReady = false;
      r.destroy();
    };
  }, []);
  return <div className="game" ref={host} />;
}

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
          <JourneyPanel />
          {s.panel === 'work' && <WorkPanel />}
          {s.panel === 'colonists' && <ColonistsPanel />}
          {s.panel === 'events' && <EventsPanel />}
          {s.panel === 'trade' && <TradePanel />}
          {s.panel === 'diplomacy' && <DiplomacyPanel />}
          <Architect />
          <OrderPreview />
          <Toasts />
          <Help />
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
    if (import.meta.env.DEV) Object.assign(window, { __fe: { store, renderer: r, command } });
    return () => r.destroy();
  }, []);
  return <div className="game" ref={host} />;
}

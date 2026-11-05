import { useEffect, useRef } from 'react';
import { calendar } from '@fe/sim';
import { leaveWorld } from '../net';
import { store, useStore } from '../store';
import { Frost } from './Frost';
import { SettingsSheet } from './SettingsSheet';
import { useSoloPause } from './useSoloPause';
import { walkChoices } from './util';

/** The game menu, the last thing Escape reaches. The same standard as the title, dropped over the world. */
export function EscapeMenu() {
  const s = useStore();
  const open = s.escMenu !== 'closed';
  const held = useSoloPause(open);
  const first = useRef<HTMLButtonElement>(null);

  // Takes the keyboard from the game while it's up: Esc steps back, the rest does nothing to the
  // world. On the document, so React's handlers run first and render/input.ts (on window) never sees the key.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (store.help) return;
      e.stopPropagation();
      if (e.key !== 'Escape') return;
      e.preventDefault();
      store.set({ escMenu: store.escMenu === 'settings' ? 'open' : 'closed' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (s.escMenu === 'open' && !s.help) first.current?.focus({ preventScroll: true });
  }, [s.escMenu, s.help]);

  // Help draws in the HUD: stand aside for it and come back when it closes.
  if (!open || s.help) return null;
  const close = () => store.set({ escMenu: 'closed' });
  const others = s.players.filter((p) => p.connected).length - 1;
  const cal = calendar(s.estTick());
  return (
    <div className="esc-menu">
      <div className="esc-dim" onClick={close} />
      <Frost reach={0.13} creep={0.28} />
      <div className="standard-hang">
        <div className="standard" role="dialog" aria-modal="true" aria-label="Game menu">
          <p className="standard-day">
            {cal.season} {cal.dayOfSeason}, year {cal.year}
          </p>
          <div className="choices" onKeyDown={walkChoices}>
            <button ref={first} className="choice first" onClick={close}>
              Resume
            </button>
            <button className="choice" onClick={() => store.set({ escMenu: s.escMenu === 'settings' ? 'open' : 'settings' })} aria-expanded={s.escMenu === 'settings'}>
              Settings
            </button>
            <button className="choice" onClick={() => store.set({ help: true })}>
              How to play
            </button>
            <button className="choice quiet" onClick={leaveWorld}>
              Leave world
              <small>{others > 0 ? 'Your colony carries on without you' : 'Your colony is saved'}</small>
            </button>
          </div>
          <p className="fine">{others > 0 ? `The game keeps running: ${others} other player${others > 1 ? 's are' : ' is'} online.` : held ? 'Paused while this menu is open.' : ''}</p>
        </div>
      </div>
      {s.escMenu === 'settings' && <SettingsSheet onClose={() => store.set({ escMenu: 'open' })} />}
    </div>
  );
}

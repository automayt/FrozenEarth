import { useEffect, useRef, useState } from 'react';
import { myPlayer, setSpeed } from '../actions';
import { store, useStore } from '../store';

/**
 * Speed is shared and, with others online, every second paused comes out of a daily pause budget.
 * So an overlay pauses the game only while you are the only one online (where pausing is free and
 * stops nobody), and resumes it on close, or as soon as someone joins. Returns whether it is
 * holding the pause right now.
 */
export function useSoloPause(open: boolean): boolean {
  useStore();
  const online = store.players.filter((p) => p.connected).length;
  const resumeTo = useRef<number | null>(null);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const me = myPlayer();
    if (open && online <= 1 && resumeTo.current === null && me && me.speed !== 0) {
      resumeTo.current = me.speed;
      setHeld(true);
      setSpeed(0);
    } else if (resumeTo.current !== null && (!open || online > 1)) {
      if (myPlayer()?.speed === 0) setSpeed(resumeTo.current);
      resumeTo.current = null;
      setHeld(false);
    }
  }, [open, online]);
  return held;
}

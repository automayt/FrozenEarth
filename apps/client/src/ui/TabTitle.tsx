import { useEffect } from 'react';
import { calendar } from '@fe/sim';
import { store } from '../store';
import { computeAlerts } from './Alerts';
import { writeLastDay } from './joinFlow';

const BASE = 'FrozenEarth';
/** Alerts walk every entity, and a tab title needn't be any fresher than this. */
const EVERY_MS = 1000;

/** The text for the browser tab: the day, with what's urgent in front of it for a player in another tab. */
export function tabTitle(day: number | null, urgent: string[]): string {
  if (day === null) return BASE;
  const parts = urgent.length ? [`(${urgent.length}) ${urgent[0]}`, `Day ${day}`, BASE] : [`Day ${day}`, BASE];
  return parts.join(' - ');
}

/** Keeps the tab's title up to date; draws nothing. */
export function TabTitle() {
  useEffect(() => {
    let lastDay = 0;
    const update = () => {
      const playing = store.status === 'playing' && !!store.mirror.w;
      const day = playing ? calendar(store.estTick()).day + 1 : null;
      const urgent = playing ? computeAlerts().filter((a) => a.severity === 'critical') : [];
      const title = tabTitle(day, urgent.map((a) => a.title));
      if (document.title !== title) document.title = title;
      if (day && store.me?.faction && day !== lastDay) {
        lastDay = day;
        writeLastDay(day);
      }
    };
    update();
    const t = setInterval(update, EVERY_MS);
    return () => clearInterval(t);
  }, []);
  return null;
}

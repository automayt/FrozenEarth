import { DAYS_PER_SEASON, DAYS_PER_YEAR, SEASONS, TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { WEATHER } from '@fe/defs';
import type { Condition } from './types';

/** Calendar fields for a tick. Pure, so clients can use it too. */
export function calendar(tick: number) {
  const day = Math.floor(tick / TICKS_PER_DAY);
  const hour = (tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
  const season = Math.floor(day / DAYS_PER_SEASON) % SEASONS.length;
  const year = Math.floor(day / (DAYS_PER_SEASON * SEASONS.length)) + 1;
  return {
    day,
    dayOfSeason: (day % DAYS_PER_SEASON) + 1,
    hour,
    season: SEASONS[season],
    year,
    label: `${SEASONS[season]} ${(day % DAYS_PER_SEASON) + 1}, Year ${year} · ${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`,
  };
}

/** Outdoor temperature in °C. Shared by the sim and client so both show the same number. */
export function outdoorTempAt(tick: number, coldOffset: number, conditions: readonly Condition[]): number {
  const yearTicks = TICKS_PER_DAY * DAYS_PER_YEAR;
  const yearFrac = (tick % yearTicks) / yearTicks;
  const hour = (tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
  // Coldest mid-winter (~-7°C), warmest mid-summer (~27°C).
  let t = 10 + 17 * Math.sin(2 * Math.PI * (yearFrac - 0.125));
  t += 5 * Math.sin((2 * Math.PI * (hour - 9)) / 24);
  for (const c of conditions) t += WEATHER[c.key]?.tempOffset ?? 0;
  return t + coldOffset;
}

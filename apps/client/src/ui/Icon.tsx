import type { ReactNode } from 'react';

/**
 * The HUD's icon set: drawn for this game in one hand (24 px grid, rounded 1.7 strokes), so
 * every slot reads as part of the same kit. Colour comes from currentColor.
 */
const PATHS: Record<string, ReactNode> = {
  // Command categories
  orders: (
    <>
      <path d="M14 10 4.5 19.5" />
      <path d="M7.5 5.2c4.4-2.6 9.4-1.9 13 2" />
      <path d="m11.5 7.2 5.3 5.3" />
    </>
  ),
  zones: (
    <>
      <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
      <path d="M10 4h4M20 10v4M10 20h4M4 10v4" opacity="0.55" />
    </>
  ),
  structure: (
    <>
      <path d="M3 6h18v13H3z" />
      <path d="M3 10.3h18M3 14.7h18M8 6v4.3M15 6v4.3M11.5 10.3v4.4M6 14.7V19M17.5 14.7V19" />
    </>
  ),
  defense: <path d="M12 3 19 6v5.5c0 4.7-3.2 7.9-7 9.5-3.8-1.6-7-4.8-7-9.5V6z" />,
  floors: (
    <>
      <path d="m3 13 9-5 9 5-9 5z" />
      <path d="m3 13v3l9 5 9-5v-3M7.5 10.5l9 5M16.5 10.5l-9 5" opacity="0.7" />
    </>
  ),
  furniture: (
    <>
      <path d="M3 19V7M3 13.5h18V19M21 13.5V12a2.5 2.5 0 0 0-2.5-2.5H10v4" />
      <circle cx="6.6" cy="11" r="1.8" />
    </>
  ),
  production: (
    <>
      <path d="M3.5 8.5h11c.3 2.6 2.2 3.8 5.5 4v2h-5.5l1.2 4.5H8.3l1.2-4.5h-2C5 14.5 3.5 12.3 3.5 8.5z" />
    </>
  ),
  temperature: <path d="M12 3c.6 3.8 5 6 5 11a5 5 0 0 1-10 0c0-2.7 1.6-4 2-6 1.3 1 2 2.4 2 4 1.4-1.8 1.6-5.4 1-9z" />,
  // Squad and panels
  draft: (
    <>
      <path d="M12 2.5 14 6v9h-4V6z" />
      <path d="M7 15h10M12 15v4.5M9.5 21.5h5" />
    </>
  ),
  work: (
    <>
      <path d="M10 6.5h10M10 12h10M10 17.5h10" />
      <path d="m3.5 6.5 1.6 1.6L7.8 5.4M3.5 12l1.6 1.6 2.7-2.7M3.5 17.5l1.6 1.6 2.7-2.7" />
    </>
  ),
  colonists: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.8 20.5c0-3.7 2.8-6.3 6.2-6.3s6.2 2.6 6.2 6.3" />
      <circle cx="17.2" cy="9" r="2.5" />
      <path d="M16 14.3c3 .3 5.3 2.6 5.3 6" />
    </>
  ),
  trade: (
    <>
      <path d="M12 4v16M7.5 20h9M4.5 7.5h15" />
      <path d="m4.5 7.5-2.7 6a2.8 2.8 0 0 0 5.4 0zM19.5 7.5l-2.7 6a2.8 2.8 0 0 0 5.4 0z" />
    </>
  ),
  diplomacy: (
    <>
      <path d="M5.5 21.5v-19" />
      <path d="M5.5 4h12.5l-3 4.2 3 4.3H5.5" />
    </>
  ),
  events: <path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.3 6L12 16.4l-5.4 3 1.3-6-4.5-4.1 6-.7z" />,
  chronicle: <path d="M3.5 5.5c2.9-1.1 5.8-1 8.5.9v13c-2.7-1.9-5.6-2-8.5-.9zM20.5 5.5c-2.9-1.1-5.8-1-8.5.9v13c2.7-1.9 5.6-2 8.5-.9z" />,
  journey: (
    <>
      <path d="M3 15.5h14.5c2 0 3.5-1.2 3.5-3.2" />
      <path d="m5.5 15.5 2-6h9l1 6M3.5 19h16" />
    </>
  ),
  // Time
  pause: <path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth={3} />,
  play: <path d="M8 5.5 18.5 12 8 18.5z" fill="currentColor" />,
  fast: <path d="M4 6.5 11.5 12 4 17.5zM12.5 6.5 20 12l-7.5 5.5z" fill="currentColor" />,
  faster: <path d="M2 7.5 8 12l-6 4.5zM9 7.5l6 4.5-6 4.5zM16 7.5l6 4.5-6 4.5z" fill="currentColor" />,
  // Odds and ends
  frost: <path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6M9.5 4.2 12 6.6l2.5-2.4M9.5 19.8l2.5-2.4 2.5 2.4M4.3 10.4l3.3-1 1-3.3M19.7 13.6l-3.3 1-1 3.3" />,
  sound: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9a4.3 4.3 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </>
  ),
  help: (
    <>
      <path d="M9.2 9.2a2.9 2.9 0 1 1 4 2.7c-.8.4-1.2 1-1.2 1.9v.7" />
      <circle cx="12" cy="17.6" r="0.6" fill="currentColor" />
    </>
  ),
  close: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  chat: <path d="M4 5.5h16v10H10l-4.5 3.5v-3.5H4z" />,
  letter: (
    <>
      <path d="M3.5 6.5h17v11h-17z" />
      <path d="m3.5 7 8.5 6.5L20.5 7" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, title }: { name: string; size?: number; title?: string }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {PATHS[name] ?? null}
    </svg>
  );
}

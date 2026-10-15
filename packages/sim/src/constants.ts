/** Simulation ticks per real second at 1× speed. */
export const TICKS_PER_SECOND = 60;
export const TICKS_PER_HOUR = 1250;
export const HOURS_PER_DAY = 24;
export const TICKS_PER_DAY = TICKS_PER_HOUR * HOURS_PER_DAY;
export const DAYS_PER_SEASON = 5;
export const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter'] as const;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS.length;

/** Slow systems (needs, plants, temperature) run once per this many ticks, staggered by entity id. */
export const RARE_TICK = 250;

/** Base ticks for a pawn to walk one orthogonal cell on cost-1 terrain (~4.6 cells/s). */
export const PAWN_TICKS_PER_CELL = 13;

/** Speeds a player can vote for. 0 = pause request. */
export const MAX_SPEED = 3;

/** Largest rectangle a single designate/build/zone command may cover. */
export const MAX_COMMAND_AREA = 80 * 80;

/** The game starts at 6am on the third day of spring, once the thaw has set in. */
export const START_TICK = TICKS_PER_DAY * 2 + TICKS_PER_HOUR * 6;

/** Things the server can refuse a join for that the title screen has an answer to. */
export type JoinTrouble = 'password' | 'name-taken' | null;

export function joinTrouble(error: string): JoinTrouble {
  if (/server password|wrong passwords/i.test(error)) return 'password';
  if (/name is taken/i.test(error)) return 'name-taken';
  return null;
}

/**
 * What to say under the form. The first time a locked server turns us away nothing has gone
 * wrong: the player just hadn't been asked yet, so the password field appearing is the whole answer.
 */
export function joinMessage(error: string, triedPassword: boolean): string {
  if (joinTrouble(error) === 'password' && /wrong server password/i.test(error) && !triedPassword) return '';
  // The form already says where the code is.
  if (joinTrouble(error) === 'name-taken') return "That name is taken. If it's yours, enter your rejoin code.";
  return error;
}

const LEADERS = ['Astrid', 'Anselm', 'Bram', 'Elias', 'Hedda', 'Ingrid', 'Ivo', 'Liv', 'Maren', 'Oskar', 'Runa', 'Sigrid', 'Soren', 'Tomas', 'Tove', 'Yara'];

/** A name to start from, different from the one showing. */
export function drawName(current: string, pick: () => number = Math.random): string {
  const pool = LEADERS.filter((n) => n !== current.trim());
  return pool[Math.floor(pick() * pool.length) % pool.length];
}

const LAST_KEY = 'fe.last';

/** What this browser last saw of its colony, for the Continue button. Never the only source of truth. */
export function readLastDay(): number | null {
  try {
    const n = Number(localStorage.getItem(LAST_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeLastDay(day: number): void {
  try {
    localStorage.setItem(LAST_KEY, String(day));
  } catch {
    // Storage blocked: the button just won't show the day.
  }
}

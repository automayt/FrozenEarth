import { dispositionOf, lineValue, priceFactor, TRADE_RANGE, type Disposition, type SettlementState } from '@fe/sim';
import type { Mirror } from '@fe/protocol';

/** Your colonist close enough to a settlement to trade there (their first name), if any. Same rule as the sim's traderAt. */
export function traderNear(m: Mirror, faction: number, home: { x: number; y: number }): string | null {
  for (const e of m.entities.values()) {
    if (e.kind !== 'pawn' || e.faction !== faction || e.downed || e.prisoner) continue;
    if (Math.hypot(e.x - home.x, e.y - home.y) <= TRADE_RANGE) return e.name.split(' ')[0];
  }
  return null;
}

export interface SettlementDeal {
  mood: Disposition;
  /** What they ask over the value you give. */
  factor: number;
  giveV: number;
  /** Their goods' value, marked up by the factor. */
  wantV: number;
  /** The settlement would turn this down (stock aside), so the send button is off. */
  blocked: boolean;
  /** Why, first reason first: they're on the move, nobody of yours is there, they're hostile and you want goods, or you offer too little. */
  why: 'moving' | 'no-trader' | 'hostile' | 'value' | null;
}

/**
 * How a settlement would price a swap, mirroring the checks settlementTrade makes on the server
 * (stock levels aside). The trade panel should use this rather than repeat the rules.
 */
export function settlementDeal(st: SettlementState, me: number, give: [string, number][], want: [string, number][], hasTrader: boolean): SettlementDeal {
  const mood = dispositionOf(st, me);
  const factor = priceFactor(st, me);
  const giveV = lineValue(give);
  const wantV = lineValue(want) * factor;
  const why = st.state !== 'home' ? 'moving' : !hasTrader ? 'no-trader' : mood === 'hostile' && want.length > 0 ? 'hostile' : giveV + 1e-9 < wantV ? 'value' : null;
  return { mood, factor, giveV, wantV, blocked: why !== null, why };
}

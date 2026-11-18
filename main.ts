// Two-tier dip-buy bot for cbBTC on 1-minute bars (agent-fun/bars-replay/v1).
//
// Strategy, in plain terms:
//   - The reference price is the highest close of the last few hours. It does
//     not chase the price down the way a moving average does, so a dip is
//     measured against where the market actually was, not where it fell to.
//   - When the close falls a first step below that reference, buy a first
//     leg. If it falls a second, deeper step, add a second leg with most of
//     what is left. Dips of that size on this pool have mostly been wobbles
//     that snap back, not the start of a collapse.
//   - Sell everything once the trade has banked its profit target over the
//     position's true average cost (the account's own cost basis, fees
//     included), or once the price climbs back near the reference, or when
//     a stop-loss says the dip really was a leg down, or when the trade has
//     simply taken too long.
//   - A falling-knife guard keeps the bot from buying a bar that is still
//     plunging, and a cooldown after each sale stops it churning fees.
//
// Everything is a deterministic function of the bars seen so far: no clock,
// no randomness, no files, no network. Orders decided on one bar fill at the
// next bar's open, so every threshold below sits well above the round-trip
// cost (about 26 bps of fee, slippage and impact on a full-size trade).
//
// The grader runs `node /bot/main.ts`; vendor/makefun-bars.ts is a
// byte-identical copy of the competition kit's SDK shim.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (bps = hundredths of a percent) ---
const LOOKBACK = 480;       // bars in the trailing-high reference window
const DIP1_BPS = 150;       // first leg: close this far below the reference
const DIP2_BPS = 260;       // second leg: close this far below it
const SPEND1_BPS = 6000;    // share of equity the first leg may spend
const SPEND2_BPS = 9500;    // share of cash the second leg may spend
const TP_BPS = 160;         // sell all at this profit over average cost
const EXIT_GAP_BPS = 30;    // ... or this close back under the reference
const STOP_BPS = 300;       // give up at this loss under average cost
const MAX_HOLD = 600;       // bars; a trade older than this is closed as-is
const COOLDOWN = 6;         // bars to wait after a sale before the next buy
const SLIPPAGE_BPS = 300;   // max_slippage_bps sent with every order
const MIN_BARS = 30;       // history needed before the first decision
const KNIFE_BPS = 60;       // a bar falling more than this is not bought
const LAST_BUY_SEQ = 1380;  // both windows run 1,440 bars; a later buy cannot pay its costs

const closes: number[] = [];
let leg = 0;                // 0 flat, 1 first leg in, 2 second leg in
let entrySeq = -1;          // seq of the bar the first leg was decided on
let cooldownUntil = -1;
let pendingLeg = 0;         // a buy for this leg was sent, not yet visible

/** The position's average entry price, from the account's cost basis. */
function avgEntry(state: BarsState, qty: bigint, cost: bigint): number {
  // price = cost_quote_units * 10^(qty_scale + price_scale) / (qty * 10^quote_scale)
  const s = state.hello.symbols.find((x) => x.symbol === SYMBOL);
  const qs = s ? s.qty_scale : 8;
  const ps = s ? s.price_scale : 5;
  const quoteScale = state.hello.capital.quote_scale;
  return Number(cost) * 10 ** (qs + ps - quoteScale) / Number(qty);
}

function buyOrder(state: BarsState, spendBps: number, ofEquity: boolean): BuyInput | null {
  let spend = ofEquity
    ? (state.equity * BigInt(spendBps)) / 10_000n
    : (state.cash * BigInt(spendBps)) / 10_000n;
  const room = state.weightRoom(SYMBOL);
  if (room < spend) spend = room;
  if (state.cash < spend) spend = state.cash;
  if (spend < 1_000_000n) return null; // below the 1 USDC minimum buy
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: SLIPPAGE_BPS };
}

function onBatch(state: BarsState, _batch: Batch): (BuyInput | SellInput)[] {
  const bar = state.latest.get(SYMBOL);
  if (bar === undefined) return [];
  const close = Number(bar.c);
  closes.push(close);
  if (closes.length > LOOKBACK) closes.shift();

  if (state.warmingUp || closes.length < MIN_BARS) return [];

  const held = state.positions.get(SYMBOL);
  const holding = held !== undefined && held.qty > 0n ? held : null;

  if (holding === null) {
    leg = 0;
    entrySeq = -1;
    pendingLeg = 0;
  }

  const ref = Math.max(...closes);
  const belowRef = (close / ref - 1) * 10_000; // negative, in bps

  if (holding !== null) {
    if (entrySeq < 0) entrySeq = state.seq;
    if (pendingLeg !== 0) pendingLeg = 0; // the pending buy has landed
    const entry = avgEntry(state, holding.qty, holding.cost);
    const gain = (close / entry - 1) * 10_000;
    if (
      gain >= TP_BPS ||               // banked the target
      belowRef >= -EXIT_GAP_BPS ||    // climbed back near the reference
      gain <= -STOP_BPS ||            // the dip was a leg down
      state.seq - entrySeq >= MAX_HOLD
    ) {
      cooldownUntil = state.seq + COOLDOWN;
      leg = 0;
      entrySeq = -1;
      pendingLeg = 0;
      return [{ side: 'sell', symbol: SYMBOL, qty: holding.qty, max_slippage_bps: SLIPPAGE_BPS }];
    }
    // Add the second leg on a deeper fall.
    if (leg === 1 && pendingLeg === 0 && belowRef <= -DIP2_BPS) {
      const order = buyOrder(state, SPEND2_BPS, false);
      if (order !== null) {
        leg = 2;
        pendingLeg = 2;
        return [order];
      }
    }
    return [];
  }

  // Flat: look for the first leg of a dip that has stopped plunging.
  if (state.seq < cooldownUntil || pendingLeg !== 0) return [];
  if (state.seq > LAST_BUY_SEQ) return [];
  if (belowRef <= -DIP1_BPS && closes.length >= 2) {
    const prev = closes[closes.length - 2];
    if (close >= prev * (1 - KNIFE_BPS / 10_000)) {
      const order = buyOrder(state, SPEND1_BPS, true);
      if (order !== null) {
        leg = 1;
        entrySeq = state.seq;
        pendingLeg = 1;
        return [order];
      }
    }
  }
  return [];
}

runBars({ onBatch });

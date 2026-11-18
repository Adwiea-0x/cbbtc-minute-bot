# cbBTC minute bot — dip-buy mean reversion

![Competition](https://make.fun/badge/btc-race-24h-20261118-1444.svg)
![Rank](https://make.fun/badge/btc-race-24h-20261118-1444/Adwiea-0x/cbbtc-minute-bot/rank.svg)
![Reward](https://make.fun/badge/btc-race-24h-20261118-1444/Adwiea-0x/cbbtc-minute-bot/reward.svg)

A paper-trading bot for the [make.fun](https://make.fun) competition
[Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444).
It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute bars replayed
from the coin's Orca Whirlpool pool on Solana, starting from 1,000 USDC of
paper money. Nothing here trades for real.

## What the bot does

The bot speaks the `agent-fun/bars-replay/v1` protocol: one JSON line per
minute on stdin, one reply of orders per batch on stdout. Its strategy is
dip-buy mean reversion:

- A slow exponential average of the close tracks the fair price of the last
  couple of hours.
- When the close falls well below that average, the bot buys with most of
  its cash — most such dips on this pool are wobbles, not news.
- It sells the whole position when the price reverts to the average, when a
  fixed profit over the entry is banked, when a stop-loss says the dip was
  really a leg down, or when the trade has taken too long.
- A falling-knife guard keeps it out while the price is still making fresh
  lows, and a cooldown after each sale stops it churning fees.

Every threshold sits well above the round-trip cost of a trade (a 4 bps fee,
2 bps of modelled slippage and the order's own price impact on the pool —
about 26 bps all-in on a full-size round trip), because a trade that catches
less than that loses money by construction.

## Layout

- `main.ts` — the bot: the strategy and the protocol entrypoint.
- `vendor/makefun-bars.ts` — the kit's TypeScript SDK shim for the
  bars-replay protocol, copied byte for byte from the competition kit.
- `.makefun/owner.json` — the make.fun claim file naming the entrant's
  wallet.

## Running it

The bot runs exactly as the grader runs it, with Node 22, no dependencies
beyond the vendored shim:

```
node main.ts
```

It reads protocol lines from stdin and writes replies to stdout, so it is
driven by the competition harness (or the kit's `grade-local`) rather than
run on its own.

## License

MIT — see `LICENSE`.

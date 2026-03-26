# Example Strategy: Basic Market Making

**Status**: Template — not active by default

Place symmetric limit orders around the midpoint to capture spread.

## Logic

For each tokenId:
1. Fetch midpoint price
2. Place bid at `midpoint * (1 - spreadPct)` and ask at `midpoint * (1 + spreadPct)`
3. Size based on available USDC balance
4. Refresh orders periodically (e.g., every 30s) to stay aligned with market

## Run

```bash
node strategies/example-market-making.js --tokenId <tokenId> --spread 0.02 --size 10
```

## Implementation Notes

- Uses `getMidpointPrice` and `place_order.js`
- Cancels existing orders before rebalancing
- Respects `tickSize` rounding
- Stops if balance insufficient

## Next Steps

- Add inventory skew: tilt bid/ask based on your net position
- Use orderbook depth to adjust spread dynamically
- Integrate with `ws_market.js` for instant updates instead of polling
- Log PnL to `trading_log.json`

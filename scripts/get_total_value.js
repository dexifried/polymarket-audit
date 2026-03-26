#!/usr/bin/env node

/**
 * Get total value of all positions (sum of shares * current midpoint price).
 * Uses Data API for positions and CLOB midpoint prices.
 *
 * Usage: node scripts/get_total_value.js
 */

import { buildReadonlyClient, buildSigner, loadEnvFallback, normalizeMidpointResponse } from '../lib/runtime.js';

loadEnvFallback();

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error('❌ PRIVATE_KEY required to identify user');
    process.exit(1);
  }

  const signer = buildSigner();
  const positionsUrl = `https://data-api.polymarket.com/positions?user=${signer.address}`;

  const posResp = await fetch(positionsUrl);
  if (!posResp.ok) {
    const err = await posResp.text();
    console.error(`❌ Data API error ${posResp.status}: ${err}`);
    process.exit(1);
  }

  const positions = await posResp.json();
  const client = buildReadonlyClient();

  let totalValue = 0;
  for (const pos of positions) {
    const tokenId = pos.token_id || pos.asset || pos.asset_id;
    const size = parseFloat(pos.size || pos.amount || 0);
    if (!tokenId || !Number.isFinite(size) || size <= 0) continue;

    try {
      const midRaw = await client.getMidpoint(tokenId);
      if (midRaw && typeof midRaw === 'object' && midRaw.error) continue;
      const mid = normalizeMidpointResponse(midRaw);
      const price = parseFloat(mid || 0.5);
      if (Number.isFinite(price)) {
        totalValue += size * price;
      }
    } catch {
      // Skip positions without an active midpoint/orderbook.
    }
  }

  console.log(JSON.stringify({ total_value_usd: totalValue }, null, 2));
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

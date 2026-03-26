#!/usr/bin/env node

/**
 * Example Market-Making Strategy
 *
 * Usage:
 *   node strategies/example-market-making.js --tokenId <id> --spread 0.02 --size 10 --refresh 30
 */

import { buildTradingClient, normalizeMidpointResponse, normalizeOpenOrdersResponse } from '../lib/runtime.js';

const args = process.argv.slice(2);
let tokenId = null;
let spread = 0.02;
let size = 10;
let refresh = 30;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--tokenId': tokenId = args[++i]; break;
    case '--spread': spread = parseFloat(args[++i]); break;
    case '--size': size = parseFloat(args[++i]); break;
    case '--refresh': refresh = parseInt(args[++i], 10); break;
  }
}

if (!tokenId) {
  console.error('❌ Usage: --tokenId <id> [--spread 0.02] [--size 10] [--refresh 30]');
  process.exit(1);
}

async function runMM() {
  const client = buildTradingClient();

  while (true) {
    try {
      const openOrders = normalizeOpenOrdersResponse(await client.getOpenOrders());
      const tokenOrders = openOrders.filter((o) => o.asset_id === tokenId || o.tokenId === tokenId || o.token_id === tokenId);
      await Promise.all(tokenOrders.map((o) => client.cancelOrder(o.id || o.orderId)));
      if (tokenOrders.length) console.log(`🧹 Cancelled ${tokenOrders.length} old orders`);

      const midStr = normalizeMidpointResponse(await client.getMidpoint(tokenId));
      const mid = parseFloat(midStr);
      if (!mid) throw new Error('Invalid midpoint');

      const bidPrice = Math.max(0.01, Number((mid * (1 - spread)).toFixed(2))).toFixed(2);
      const askPrice = Number((mid * (1 + spread)).toFixed(2)).toFixed(2);

      await client.createAndPostOrder(
        { tokenID: tokenId, price: bidPrice, size: size.toFixed(2), side: 'BUY' },
        { tickSize: '0.01', negRisk: false }
      );
      await client.createAndPostOrder(
        { tokenID: tokenId, price: askPrice, size: size.toFixed(2), side: 'SELL' },
        { tickSize: '0.01', negRisk: false }
      );

      console.log(`[${new Date().toISOString()}] MM on ${tokenId}: bid ${bidPrice} / ask ${askPrice} (mid: ${mid.toFixed(2)})`);
    } catch (err) {
      console.error('❌ MM cycle error:', err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, refresh * 1000));
  }
}

runMM().catch((err) => {
  console.error(err);
  process.exit(1);
});

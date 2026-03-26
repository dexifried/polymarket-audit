#!/usr/bin/env node

/**
 * Get orderbook for a token ID
 *
 * Usage: node scripts/get_orderbook.js <tokenId> [--depth 20]
 */

import { buildReadonlyClient } from '../lib/runtime.js';

const client = buildReadonlyClient();

const args = process.argv.slice(2);
const tokenId = args[0];
const depthIdx = args.indexOf('--depth');
const depth = depthIdx !== -1 ? parseInt(args[depthIdx+1], 10) : 20;

if (!tokenId) {
  console.error("❌ Usage: node scripts/get_orderbook.js <tokenId> [--depth 20]");
  process.exit(1);
}

try {
  const orderbook = await client.getOrderBook(tokenId);
  if (orderbook && typeof orderbook === 'object' && orderbook.error) {
    throw new Error(orderbook.error);
  }
  console.log(JSON.stringify(orderbook, null, 2));
} catch (err) {
  console.error("❌ Error fetching orderbook:", err.message);
  process.exit(1);
}

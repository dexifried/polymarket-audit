#!/usr/bin/env node

/**
 * Get trade history for the authenticated user
 *
 * Usage: node scripts/get_trades.js [--limit 100]
 */

import { buildTradingClient } from '../lib/runtime.js';

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit')+1], 10) : 100;
const offset = args.includes('--offset') ? parseInt(args[args.indexOf('--offset')+1], 10) : 0;

try {
  const client = buildTradingClient();
  const trades = await client.getTrades({ limit, offset });
  console.log(JSON.stringify(trades, null, 2));
} catch (err) {
  console.error("❌ Error fetching trades:", err.message);
  process.exit(1);
}

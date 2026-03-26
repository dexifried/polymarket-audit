#!/usr/bin/env node

/**
 * Get open orders for the authenticated user
 *
 * Usage: node scripts/get_orders.js [--limit 50]
 */

import { buildTradingClient } from '../lib/runtime.js';

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit')+1], 10) : 50;

try {
  const client = buildTradingClient();
  // SDK method: getOpenOrders (optionally with params)
  const orders = await client.getOpenOrders();
  console.log(JSON.stringify(orders, null, 2));
} catch (err) {
  console.error("❌ Error fetching orders:", err.message);
  process.exit(1);
}

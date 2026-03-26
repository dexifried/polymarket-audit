#!/usr/bin/env node

/**
 * List open orders for the authenticated user
 *
 * Usage: node scripts/get_open_orders.js
 */

import { buildTradingClient } from '../lib/runtime.js';

try {
  const client = buildTradingClient();
  const orders = await client.getOpenOrders();
  console.log(JSON.stringify(orders, null, 2));
} catch (err) {
  console.error("❌ Error fetching open orders:", err.message);
  process.exit(1);
}

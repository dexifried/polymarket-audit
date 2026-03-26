#!/usr/bin/env node

/**
 * Cancel a single order by order ID
 *
 * Usage: node scripts/cancel_order.js <orderId>
 */

import { buildTradingClient } from '../lib/runtime.js';

const orderId = process.argv[2];
if (!orderId) {
  console.error("❌ Usage: node scripts/cancel_order.js <orderId>");
  process.exit(1);
}

try {
  const client = buildTradingClient();
  await client.cancelOrder(orderId);
  console.log(`✅ Cancelled order ${orderId}`);
} catch (err) {
  console.error("❌ Cancel failed:", err.message);
  process.exit(1);
}

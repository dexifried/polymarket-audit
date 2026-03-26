#!/usr/bin/env node

/**
 * Cancel all open orders (safe, works even in cancel-only mode)
 *
 * Usage: node scripts/cancel_all.js
 */

import { buildTradingClient } from '../lib/runtime.js';

try {
  const client = buildTradingClient();
  await client.cancelAll();
  console.log("✅ All open orders cancelled");
} catch (err) {
  console.error("❌ Cancel all failed:", err.message);
  process.exit(1);
}

#!/usr/bin/env node

/**
 * Get account balances (USDC, allowances)
 *
 * Usage: node scripts/get_balance.js
 */

import { buildTradingClient } from '../lib/runtime.js';

try {
  const client = buildTradingClient();
  // SDK method: getBalanceAllowance
  const result = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
  // Convert wei to USDC (6 decimals)
  const balance_usdc = Number(result.balance) / 1e6;
  const allowance_usdc = Number(result.allowance) / 1e6;
  console.log(JSON.stringify({ balance_usdc, allowance_usdc }, null, 2));
} catch (err) {
  console.error("❌ Error fetching balance:", err.message);
  process.exit(1);
}

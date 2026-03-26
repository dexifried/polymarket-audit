#!/usr/bin/env node

/**
 * Get last trade price for a token
 *
 * Usage: node scripts/get_last_trade.js <tokenId>
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import 'dotenv/config';

const HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = parseInt(process.env.POLYMARKET_CHAIN_ID || "137");

const client = new ClobClient(HOST, CHAIN_ID);

const tokenId = process.argv[2];
if (!tokenId) {
  console.error("❌ Usage: node scripts/get_last_trade.js <tokenId>");
  process.exit(1);
}

try {
  const { price, side } = await client.getLastTradePrice(tokenId);
  console.log(JSON.stringify({ tokenId, lastTradePrice: price, side }, null, 2));
} catch (err) {
  console.error("❌ Error fetching last trade:", err.message);
  process.exit(1);
}

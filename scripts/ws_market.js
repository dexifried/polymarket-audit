#!/usr/bin/env node

/**
 * Subscribe to market updates (orderbook, trades, prices) via WebSocket
 *
 * Usage: node scripts/ws_market.js <tokenId> [--output json]
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';

const HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = parseInt(process.env.POLYMARKET_CHAIN_ID || "137");

function buildClient() {
  if (!existsSync('.polymarket-credentials.json')) {
    throw new Error("Missing .polymarket-credentials.json for user WS. Run setup_auth.js first.");
  }
  const creds = JSON.parse(readFileSync('.polymarket-credentials.json', 'utf8'));
  const signer = new Wallet(process.env.PRIVATE_KEY);
  return new ClobClient(HOST, CHAIN_ID, signer, creds, 0, signer.address);
}

const tokenId = process.argv[2];
const jsonOut = process.argv.includes('--output') && process.argv[process.argv.indexOf('--output')+1] === 'json';

if (!tokenId) {
  console.error("❌ Usage: node scripts/ws_market.js <tokenId> [--output json]");
  process.exit(1);
}

try {
  const client = buildClient();
  console.log(`🔌 Subscribing to market channel for token ${tokenId}...`);

  client.subscribe(tokenId, (msg) => {
    if (jsonOut) {
      console.log(JSON.stringify(msg));
    } else {
      const { event, data } = msg;
      switch (event) {
        case 'order':
          console.log(`[ORDER] ${data.orderId} ${data.side} ${data.size} @ ${data.price}`);
          break;
        case 'trade':
          console.log(`[TRADE] ${data.tradeId} ${data.side} ${data.price} x ${data.size}`);
          break;
        case 'book':
          console.log(`[BOOK] bids:${data.bids?.length||0} asks:${data.asks?.length||0}`);
          break;
        default:
          console.log(`[${event.toUpperCase()}]`, data);
      }
    }
  });
} catch (err) {
  console.error("❌ WS error:", err.message);
  process.exit(1);
}

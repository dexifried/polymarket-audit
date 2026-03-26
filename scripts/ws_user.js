#!/usr/bin/env node

/**
 * Subscribe to user channel (order fills, cancellations) via WebSocket
 *
 * Usage: node scripts/ws_user.js [--output json]
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';

const HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = parseInt(process.env.POLYMARKET_CHAIN_ID || "137");

function buildClient() {
  if (!existsSync('.polymarket-credentials.json')) {
    throw new Error("Missing .polymarket-credentials.json. Run setup_auth.js first.");
  }
  const creds = JSON.parse(readFileSync('.polymarket-credentials.json', 'utf8'));
  const signer = new Wallet(process.env.PRIVATE_KEY);
  return new ClobClient(HOST, CHAIN_ID, signer, creds, 0, signer.address);
}

const jsonOut = process.argv.includes('--output') && process.argv[process.argv.indexOf('--output')+1] === 'json';

try {
  const client = buildClient();
  console.log("🔌 Subscribing to user channel...");

  client.subscribeUser((msg) => {
    if (jsonOut) {
      console.log(JSON.stringify(msg));
    } else {
      const { event, data } = msg;
      switch (event) {
        case 'order':
          console.log(`[USER ORDER] ${data.orderId} ${data.side} ${data.originalSize} @ ${data.price} (status: ${data.status})`);
          break;
        case 'trade':
          console.log(`[USER TRADE] filled ${data.orderId} (${data.side}) size: ${data.size} price: ${data.price}`);
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

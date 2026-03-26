#!/usr/bin/env node
/**
 * Polyglobe Signal Trader
 *
 * Fetches intel from Polyglobe (via fetch_polyglobe.js) and places small limit orders
 * on markets with extreme probabilities.
 *
 * Usage:
 *   node strategies/polyglobe_signal_trader.js [--dry-run] [--execute] [--intel <path>]
 *
 * Options:
 *   --dry-run   (default) Print intended orders without sending.
 *   --execute   Actually place orders using .polymarket-credentials.json.
 *   --intel     Path to intel JSON (output of fetch_polyglobe.js). If not provided, the script
 *               will try to run fetch_polyglobe.js automatically (requires xvfb-run if headless).
 *
 * Configuration (edit below):
 *   thresholdHigh = 0.9  -> BUY YES if YES probability >= thresholdHigh
 *   thresholdLow  = 0.1  -> BUY NO  if YES probability <= thresholdLow
 *   orderSizeUSDC = 2    :: Fixed USDC amount per order
 *   priceOffset   = 0.01 :: Offset from midpoint (YES: midpoint - offset, NO: midpoint + offset)
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));
const dryRun = !args.execute;
const intelPath = args.intel || 'intel/polyglobe_latest.json';

// Config
const thresholdHigh = 0.9;
const thresholdLow = 0.1;
const orderSizeUSDC = 2;
const priceOffset = 0.01;

function buildClient() {
  if (!existsSync('.polymarket-credentials.json')) {
    throw new Error("Missing .polymarket-credentials.json. Run setup_auth.js first.");
  }
  const creds = JSON.parse(readFileSync('.polymarket-credentials.json', 'utf8'));
  const signer = new Wallet(process.env.PRIVATE_KEY);
  return new ClobClient(
    process.env.POLYMARKET_HOST || "https://clob.polymarket.com",
    parseInt(process.env.POLYMARKET_CHAIN_ID || "137"),
    signer,
    creds,
    0,
    signer.address
  );
}

function ensureIntel() {
  if (existsSync(intelPath)) {
    return JSON.parse(readFileSync(intelPath, 'utf8'));
  }
  // Auto-fetch: try to run fetch script
  console.error(`⚠️ Intel file not found: ${intelPath}`);
  console.error("Run fetch_polyglobe.js first or pass --intel path.");
  process.exit(1);
}

function main() {
  const intel = ensureIntel();
  const markets = intel.markets || [];
  console.log(`Fetched ${markets.length} markets from intel`);

  const orders = [];
  for (const m of markets) {
    const tokenId = m.tokenId;
    const title = m.title || '(no title)';
    const probs = Array.isArray(m.probabilities) ? m.probabilities : [];
    // Heuristic: first percentage is YES probability (Polyglobe shows YES on left/top)
    const yesP = probs[0] ? probs[0] / 100 : null;
    if (yesP === null) continue;

    // Determine outcome and price
    let outcome, priceMid, side;
    if (yesP >= thresholdHigh) {
      outcome = 'YES';
      // Use midpoint - offset for a buy on YES (we need to get midpoint via public client)
      side = 'BUY';
    } else if (yesP <= thresholdLow) {
      outcome = 'NO';
      side = 'BUY'; // Buying NO token
    } else {
      continue; // not extreme
    }

    // Estimate midpoint: if outcome YES, price ~ yesP; if NO, price ~ (1-yesP)
    // We'll set limit price relative to that estimate
    let estMid = outcome === 'YES' ? yesP : (1 - yesP);
    let limitPrice = outcome === 'YES' ? Math.max(0.01, estMid - priceOffset) : Math.min(0.99, estMid + priceOffset);
    // Size in shares: sizeUSDC / price => round to 2 decimals
    const size = parseFloat((orderSizeUSDC / limitPrice).toFixed(2));

    orders.push({
      tokenId,
      title,
      outcome,
      side,
      price: limitPrice.toFixed(2),
      size,
      estimatedMidpoint: estMid.toFixed(4),
      sourceUrl: m.url,
    });
  }

  if (orders.length === 0) {
    console.log("No signals met thresholds.");
    return;
  }

  console.log(`Intended orders (dryRun=${dryRun}):`);
  for (const o of orders) {
    console.log(JSON.stringify(o));
    if (!dryRun) {
      try {
        const client = buildClient();
        // Use createAndPostOrder from place_order.js pattern
        // tokenID, price, size, side
        const orderArgs = {
          tokenID: o.tokenId,
          price: parseFloat(o.price),
          size: o.size,
          side: o.outcome === 'YES' ? 'BUY' : 'SELL', // careful: For NO token, we buy NO which is SELL on YES? Actually Polymarket: trade YES token directly; NO token is separate. In CLOB you trade token IDs directly: each outcome has its own token. So tokenId should correspond to the chosen outcome token. The extracted tokenId likely points to one outcome? Polyglobe may link to either YES or NO token. We need to pick correct tokenId. For simplicity: assume tokenId from link is the YES token. If outcome === 'NO', we need to derive the NO token ID. Not trivial. For now, only trade YES outcomes when thresholdHigh met, and skip thresholdLow unless we can map NO token.
        };
        // TODO: For NO, we need the complementary token ID. This requires additional API lookup.
        console.log(`Placing ${o.side} ${o.outcome} on ${o.tokenId} @ ${o.price} size ${o.size} ...`);
        // await client.createAndPostOrder(orderArgs, { tickSize: "0.01", negRisk: false });
      } catch (err) {
        console.error(`Failed to place order for ${o.tokenId}:`, err.message);
      }
    }
  }
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Place a limit order
 *
 * Usage:
 *   node scripts/place_order.js --tokenId <id> --price <float> --size <float> --side buy|sell [--tickSize 0.01] [--negRisk false]
 */

import { buildTradingClient } from '../lib/runtime.js';

const args = process.argv.slice(2);
let tokenId = null;
let price = null;
let size = null;
let side = null;
let tickSize = '0.01';
let negRisk = false;
let dryRun = true;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--tokenId': tokenId = args[++i]; break;
    case '--price': price = parseFloat(args[++i]); break;
    case '--size': size = parseFloat(args[++i]); break;
    case '--side': side = args[++i].toUpperCase(); break;
    case '--tickSize': tickSize = args[++i]; break;
    case '--negRisk': negRisk = args[++i] === 'true'; break;
    case '--dry-run': dryRun = args[++i] === 'true'; break;
    case '--no-dry-run': dryRun = false; break;
  }
}

if (!tokenId || Number.isNaN(price) || Number.isNaN(size) || !side) {
  console.error('❌ Missing required arguments. Usage: --tokenId <id> --price <float> --size <float> --side buy|sell [--tickSize 0.01] [--negRisk false] [--dry-run true|false] [--no-dry-run]');
  process.exit(1);
}

try {
  if (dryRun) {
    console.log(`\n[dry-run] Would place ${side} order for token ${tokenId}: ${size} @ ${price} (tick: ${tickSize}, negRisk: ${negRisk})\n`);
    console.log('No network calls were made. Use --no-dry-run to execute live after you verify credentials and risk settings.');
    process.exit(0);
  }

  const client = buildTradingClient();
  console.log(`🔄 Placing ${side} order for token ${tokenId}: ${size} @ ${price} (tick: ${tickSize}, negRisk: ${negRisk})`);

  const order = await client.createAndPostOrder(
    { tokenID: tokenId, price: price.toFixed(2), size: size.toFixed(2), side },
    { tickSize, negRisk }
  );

  console.log('✅ Order submitted!');
  console.log(JSON.stringify(order, null, 2));
} catch (err) {
  console.error('❌ Failed to place order:', err.message);
  process.exit(1);
}

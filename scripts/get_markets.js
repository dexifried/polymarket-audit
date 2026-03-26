#!/usr/bin/env node

/**
 * List active markets with optional filtering
 *
 * Usage:
 *   node scripts/get_markets.js [--tag "politics"] [--limit 50]
 */

import { buildReadonlyClient, normalizeMarketsResponse } from '../lib/runtime.js';

// Parse simple flags: --tag "value" --limit 50
const args = process.argv.slice(2);
let tag = null;
let limit = 100;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tag' && args[i+1]) {
    tag = args[i+1];
    i++;
  } else if (args[i] === '--limit' && args[i+1]) {
    limit = parseInt(args[i+1], 10);
    i++;
  }
}

try {
  const client = buildReadonlyClient();
  let markets = normalizeMarketsResponse(await client.getMarkets());

  if (tag) {
    markets = markets.filter(m => m.tags?.some(t => String(t).toLowerCase().includes(tag.toLowerCase())));
  }

  markets = markets.slice(0, limit);

  console.log(JSON.stringify(markets, null, 2));
} catch (err) {
  console.error("❌ Error fetching markets:", err.message);
  process.exit(1);
}

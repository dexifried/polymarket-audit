#!/usr/bin/env node

/**
 * Get midpoint price for a token
 *
 * Usage: node scripts/get_midpoint.js <tokenId>
 */

import { buildReadonlyClient, normalizeMidpointResponse } from '../lib/runtime.js';

const client = buildReadonlyClient();

const tokenId = process.argv[2];
if (!tokenId) {
  console.error('❌ Usage: node scripts/get_midpoint.js <tokenId>');
  process.exit(1);
}

try {
  const raw = await client.getMidpoint(tokenId);
  if (raw && typeof raw === 'object' && raw.error) {
    throw new Error(raw.error);
  }

  const price = normalizeMidpointResponse(raw);
  console.log(JSON.stringify({ tokenId, midpoint: price }, null, 2));
} catch (err) {
  console.error('❌ Error fetching midpoint:', err.message);
  process.exit(1);
}

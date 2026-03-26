#!/usr/bin/env node

/**
 * Verify the Polymarket skill against the currently installed SDK.
 *
 * Default behavior:
 * - verifies public/read-only functionality
 * - reports live trading readiness if PRIVATE_KEY + API creds are available
 *
 * Optional:
 *   node scripts/verify.js --require-live
 *   -> fails unless authenticated trading checks also pass
 */

import { existsSync, readFileSync } from 'fs';
import {
  buildReadonlyClient,
  buildTradingClient,
  getCredentialsPath,
  loadEnvFallback,
  normalizeMarketsResponse,
  normalizeMidpointResponse,
  normalizeOpenOrdersResponse,
} from '../lib/runtime.js';

loadEnvFallback();

const requireLive = process.argv.includes('--require-live');
const credsPath = getCredentialsPath();

console.log('🔍 Polymarket skill verification\n');

let publicOk = false;
let liveOk = false;

try {
  const client = buildReadonlyClient();
  const markets = normalizeMarketsResponse(await client.getMarkets());

  if (!markets.length) {
    throw new Error('getMarkets() returned no markets');
  }

  console.log(`✅ Public markets API reachable — fetched ${markets.length} markets`);

  const samplingMarkets = normalizeMarketsResponse(await client.getSamplingMarkets());
  const sampleToken = samplingMarkets
    .flatMap((market) => market.tokens || [])
    .map((token) => token.token_id || token.tokenId)
    .find(Boolean);

  if (!sampleToken) {
    throw new Error('could not find a live sample token_id from sampling markets');
  }

  const midpointRaw = await client.getMidpoint(sampleToken);
  const orderBook = await client.getOrderBook(sampleToken);

  if (midpointRaw && typeof midpointRaw === 'object' && midpointRaw.error) {
    throw new Error(`sample midpoint lookup failed: ${midpointRaw.error}`);
  }
  if (orderBook && typeof orderBook === 'object' && orderBook.error) {
    throw new Error(`sample orderbook lookup failed: ${orderBook.error}`);
  }

  const midpoint = normalizeMidpointResponse(midpointRaw);
  console.log(`✅ Midpoint API reachable — sample token ${sampleToken.slice(0, 10)}… midpoint ${midpoint}`);
  console.log(`✅ Orderbook API reachable — bids ${orderBook?.bids?.length || 0}, asks ${orderBook?.asks?.length || 0}`);

  publicOk = true;
} catch (err) {
  console.error(`❌ Public verification failed: ${err.message}`);
  process.exit(1);
}

const hasPrivateKey = Boolean(process.env.PRIVATE_KEY);
const hasCredsFile = existsSync(credsPath);

if (hasPrivateKey) {
  console.log('✅ PRIVATE_KEY available');
} else {
  console.log('ℹ️ PRIVATE_KEY not loaded — skipping authenticated checks');
}

if (hasCredsFile) {
  try {
    const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
    const credsOk = Boolean(creds?.key && creds?.secret && creds?.passphrase);
    if (!credsOk) {
      throw new Error('credentials file is missing key/secret/passphrase');
    }
    console.log('✅ .polymarket-credentials.json looks complete');
  } catch (err) {
    console.error(`⚠️ Credentials file present but invalid: ${err.message}`);
    if (requireLive) process.exit(1);
  }
} else {
  console.log('ℹ️ .polymarket-credentials.json not found — live trading not configured yet');
}

if (hasPrivateKey && hasCredsFile) {
  try {
    const liveClient = buildTradingClient();
    const openOrders = normalizeOpenOrdersResponse(await liveClient.getOpenOrders());
    console.log(`✅ Authenticated trading API reachable — open orders: ${openOrders.length}`);
    liveOk = true;
  } catch (err) {
    console.error(`⚠️ Authenticated verification failed: ${err.message}`);
    if (requireLive) process.exit(1);
  }
}

console.log('');
if (publicOk && liveOk) {
  console.log('🎉 Skill is functional in public mode and live-trading mode.');
} else if (publicOk) {
  console.log('🎉 Skill is functional in public mode. Live trading is not fully configured/verified yet.');
}

#!/usr/bin/env node

import { buildReadonlyClient, normalizeMarketsResponse } from '../lib/runtime.js';

const CRYPTO_REGEX = /(bitcoin|\bbtc\b|ethereum|\beth\b)/i;
const DIRECTION_REGEX = /(up|down|higher|lower|above|below)/i;
const WINDOW_REGEXES = [
  { label: '5m', regex: /(5\s*(min|minute|minutes)|5m)/i, seconds: 300 },
  { label: '15m', regex: /(15\s*(min|minute|minutes)|15m)/i, seconds: 900 },
  { label: '1h', regex: /(1\s*(hour|hr)|1h)/i, seconds: 3600 },
];

function assetFromText(text) {
  if (/bitcoin|\bbtc\b/i.test(text)) return 'BTC';
  if (/ethereum|\beth\b/i.test(text)) return 'ETH';
  return null;
}

function parseResolutionTime(market) {
  const candidates = [
    market?.end_date_iso,
    market?.endDate,
    market?.resolution_date,
    market?.resolutionDate,
    market?.resolve_time,
    market?.endTime,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const ts = new Date(candidate).toISOString?.();
    if (ts && ts !== 'Invalid Date') return ts;
  }
  return null;
}

function inferWindow(question, slug = '') {
  const haystack = `${question} ${slug}`;
  return WINDOW_REGEXES.find((entry) => entry.regex.test(haystack)) ?? null;
}

function normalizeTokenIds(tokens = []) {
  const normalized = { yes: null, no: null };
  for (const token of tokens) {
    const outcome = String(token?.outcome || token?.name || '').toLowerCase();
    if (outcome === 'yes') normalized.yes = token?.token_id ?? token?.id ?? null;
    if (outcome === 'no') normalized.no = token?.token_id ?? token?.id ?? null;
  }
  return normalized;
}

function currentPrices(tokens = []) {
  const result = { yes: null, no: null };
  for (const token of tokens) {
    const outcome = String(token?.outcome || token?.name || '').toLowerCase();
    const price = Number(token?.price ?? token?.last_trade_price ?? token?.mid ?? NaN);
    if (outcome === 'yes' && Number.isFinite(price)) result.yes = price;
    if (outcome === 'no' && Number.isFinite(price)) result.no = price;
  }
  return result;
}

export function isCryptoShortDurationMarket(market) {
  const question = String(market?.question || market?.title || '');
  const slug = String(market?.slug || '');
  const text = `${question} ${slug}`;
  return CRYPTO_REGEX.test(text) && DIRECTION_REGEX.test(text) && WINDOW_REGEXES.some((entry) => entry.regex.test(text));
}

export function normalizeCryptoMarket(market, now = Date.now()) {
  if (!isCryptoShortDurationMarket(market)) return null;

  const question = String(market?.question || market?.title || '').trim();
  const slug = String(market?.slug || '');
  const window = inferWindow(question, slug);
  const underlyingAsset = assetFromText(`${question} ${slug}`);
  const resolutionTime = parseResolutionTime(market);
  const resolutionMs = resolutionTime ? Date.parse(resolutionTime) : null;
  const expired = Number.isFinite(resolutionMs) ? resolutionMs <= now : false;
  const tokenIds = normalizeTokenIds(market?.tokens || []);
  const prices = currentPrices(market?.tokens || []);

  return {
    marketId: market?.condition_id ?? market?.id ?? null,
    slug,
    question,
    resolutionTime,
    windowLength: window?.label ?? null,
    windowSeconds: window?.seconds ?? null,
    underlyingAsset,
    tokenIds,
    currentPrice: prices,
    expired,
    active: Boolean(market?.active && !market?.closed && !expired),
    enableOrderBook: Boolean(market?.enable_order_book),
    raw: {
      liquidity: market?.liquidity ?? null,
      volume: market?.volume ?? null,
      acceptingOrders: market?.accepting_orders ?? null,
    },
  };
}

export async function discoverCryptoMarkets() {
  const client = buildReadonlyClient();
  let markets = [];

  try {
    markets = normalizeMarketsResponse(await client.getSamplingMarkets());
  } catch {
    markets = normalizeMarketsResponse(await client.getMarkets());
  }

  const now = Date.now();
  return markets
    .map((market) => normalizeCryptoMarket(market, now))
    .filter(Boolean)
    .filter((market) => market.underlyingAsset && (market.tokenIds.yes || market.tokenIds.no));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const markets = await discoverCryptoMarkets();
  process.stdout.write(`${JSON.stringify(markets, null, 2)}\n`);
}

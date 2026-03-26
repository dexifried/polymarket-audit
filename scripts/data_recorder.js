#!/usr/bin/env node

import { mkdirSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import { SKILL_ROOT, getHost, loadEnvFallback } from '../lib/runtime.js';

loadEnvFallback();

const args = minimist(process.argv.slice(2), {
  boolean: ['once'],
  string: ['markets', 'interval'],
});

const intervalMs = Math.max(1000, Number(args.interval || 10) * 1000);
const once = Boolean(args.once);
const selectedSlugs = new Set(
  String(args.markets || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

const clobHost = getHost();
const gammaHost = process.env.POLYMARKET_GAMMA_HOST || 'https://gamma-api.polymarket.com';
const outputDir = resolve(SKILL_ROOT, 'memory', 'paper', 'orderbook_history');
const concurrency = Math.max(1, Number(process.env.POLYMARKET_RECORDER_CONCURRENCY || args.concurrency || 16));
mkdirSync(outputDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 6) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** digits;
  return Math.round((numeric + Number.EPSILON) * factor) / factor;
};

function dateFileFor(ts) {
  return resolve(outputDir, `${ts.slice(0, 10)}.jsonl`);
}

function appendJsonl(filePath, record) {
  appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

function normalizeLevels(levels, side) {
  const entries = Array.isArray(levels) ? levels : [];
  const normalized = entries
    .map((level) => ({ price: Number(level?.price), size: Number(level?.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => side === 'bids' ? b.price - a.price : a.price - b.price);
  return normalized;
}

function sumDepth(levels, count = 5) {
  return round(
    levels
      .slice(0, count)
      .reduce((sum, level) => sum + (Number(level.price) * Number(level.size)), 0),
    6
  );
}

function snapshotFromBook(market, token, book, ts) {
  const bids = normalizeLevels(book?.bids, 'bids');
  const asks = normalizeLevels(book?.asks, 'asks');
  const bestBid = bids[0] || null;
  const bestAsk = asks[0] || null;
  const midPrice = bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : null;
  const spreadBps = bestBid && bestAsk && midPrice > 0
    ? ((bestAsk.price - bestBid.price) / midPrice) * 10000
    : null;

  return {
    ts,
    market_id: String(market.id || market.conditionId || market.condition_id || ''),
    question: market.question || null,
    slug: market.slug || market.market_slug || null,
    token_id: String(token.token_id),
    outcome: token.outcome || null,
    best_bid: round(bestBid?.price, 6),
    best_bid_size: round(bestBid?.size, 6),
    best_ask: round(bestAsk?.price, 6),
    best_ask_size: round(bestAsk?.size, 6),
    spread_bps: round(spreadBps, 4),
    mid_price: round(midPrice, 6),
    depth_5_bid: sumDepth(bids, 5),
    depth_5_ask: sumDepth(asks, 5),
  };
}

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchActiveMarkets() {
  const limit = Number(process.env.POLYMARKET_GAMMA_LIMIT || 500);
  const url = new URL('/markets', gammaHost);
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  url.searchParams.set('archived', 'false');
  url.searchParams.set('limit', String(limit));

  const markets = await fetchJson(url.toString());
  const filtered = (Array.isArray(markets) ? markets : [])
    .filter((market) => market?.active && !market?.closed && market?.enableOrderBook && market?.acceptingOrders)
    .filter((market) => !selectedSlugs.size || selectedSlugs.has(String(market.slug || '').toLowerCase()));

  return filtered.flatMap((market) => {
    let outcomes = market.outcomes;
    if (typeof outcomes === 'string') {
      try {
        outcomes = JSON.parse(outcomes);
      } catch {
        outcomes = [];
      }
    }
    outcomes = Array.isArray(outcomes) ? outcomes : [];
    let tokenIds = market.clobTokenIds;
    if (typeof tokenIds === 'string') {
      try {
        tokenIds = JSON.parse(tokenIds);
      } catch {
        tokenIds = [];
      }
    }

    return (Array.isArray(tokenIds) ? tokenIds : [])
      .map((tokenId, index) => ({
        market,
        token: {
          token_id: String(tokenId),
          outcome: outcomes[index] || null,
        },
      }))
      .filter((entry) => entry.token.token_id);
  });
}

async function fetchOrderBook(tokenId) {
  const url = new URL('/book', clobHost);
  url.searchParams.set('token_id', String(tokenId));
  return fetchJson(url.toString(), 12000);
}

async function recordCycle() {
  const ts = new Date().toISOString();
  const filePath = dateFileFor(ts);
  let targets = [];
  let recorded = 0;
  let errors = 0;

  try {
    targets = await fetchActiveMarkets();
  } catch (error) {
    console.error(`❌ Failed to fetch active markets: ${error.message}`);
    console.log('📊 Recorded 0/0 markets, 1 errors');
    return;
  }

  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length || 1) }, async () => {
    while (index < targets.length) {
      const current = targets[index];
      index += 1;
      try {
        const book = await fetchOrderBook(current.token.token_id);
        const snapshot = snapshotFromBook(current.market, current.token, book, ts);
        appendJsonl(filePath, snapshot);
        recorded += 1;
      } catch (error) {
        errors += 1;
        console.error(`⚠️ ${current.market.slug || current.market.question} / ${current.token.outcome || current.token.token_id}: ${error.message}`);
      }
    }
  });

  await Promise.all(workers);
  console.log(`📊 Recorded ${recorded}/${targets.length} markets, ${errors} errors`);
}

async function main() {
  do {
    await recordCycle();
    if (once) break;
    await sleep(intervalMs);
  } while (true);
}

main().catch((error) => {
  console.error(`❌ Recorder crashed: ${error.message}`);
  process.exit(1);
});

#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { resolve } from 'path';
import { SKILL_ROOT } from '../lib/runtime.js';
import { simulateL2Fill } from '../lib/l2_simulator.js';

const paperDir = resolve(SKILL_ROOT, 'memory', 'paper');
const decisionsPath = resolve(paperDir, 'decisions.jsonl');
const tradesPath = resolve(paperDir, 'trades.jsonl');
const orderbookDir = resolve(paperDir, 'orderbook_history');
const reportPath = resolve(paperDir, 'fill_quality_report.json');

const round = (value, digits = 6) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** digits;
  return Math.round((numeric + Number.EPSILON) * factor) / factor;
};

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[index], 4);
}

function median(values) {
  return percentile(values, 50);
}

function parseSnapshotLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function snapshotDistanceMs(snapshotTs, decisionTs) {
  return Math.abs(new Date(snapshotTs).getTime() - new Date(decisionTs).getTime());
}

async function loadHistoryFiles() {
  if (!existsSync(orderbookDir)) return [];
  const names = await readdir(orderbookDir);
  return names.filter((name) => name.endsWith('.jsonl')).sort();
}

async function findNearestSnapshot(tokenId, decisionTs) {
  const files = await loadHistoryFiles();
  let best = null;

  for (const name of files) {
    const fullPath = resolve(orderbookDir, name);
    const lines = readFileSync(fullPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const snapshot = parseSnapshotLine(line);
      if (!snapshot || String(snapshot.token_id) !== String(tokenId)) continue;
      const distance = snapshotDistanceMs(snapshot.ts, decisionTs);
      if (!best || distance < best.distance) {
        best = { snapshot, distance };
      }
    }
  }

  return best?.snapshot || null;
}

function decisionActualPrice(decision, tradeIndex) {
  const direct = Number(decision.entryPrice ?? decision.entry_price ?? decision.avg_fill_price);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const trade = tradeIndex.get(`${decision.ts}|${decision.tokenId || decision.token_id}|${decision.type}`)
    || tradeIndex.get(`${decision.tokenId || decision.token_id}|${decision.type}`);
  const tradePrice = Number(trade?.entryPrice ?? trade?.exitPrice);
  return Number.isFinite(tradePrice) && tradePrice > 0 ? tradePrice : null;
}

function buildTradeIndex(trades) {
  const index = new Map();
  for (const trade of trades) {
    const tokenId = trade.tokenId || trade.token_id;
    if (!tokenId) continue;
    if (trade.type) {
      index.set(`${trade.ts}|${tokenId}|${trade.type === 'ENTRY' ? 'BUY' : trade.type}`, trade);
      index.set(`${tokenId}|${trade.type === 'ENTRY' ? 'BUY' : trade.type}`, trade);
    }
  }
  return index;
}

function reconstructBook(snapshot) {
  const bidPrice = Number(snapshot.best_bid);
  const askPrice = Number(snapshot.best_ask);
  const bidSize = bidPrice > 0 && Number(snapshot.best_bid_size) > 0
    ? Number(snapshot.best_bid_size)
    : (Number(snapshot.depth_5_bid) > 0 && bidPrice > 0 ? Number(snapshot.depth_5_bid) / bidPrice : 0);
  const askSize = askPrice > 0 && Number(snapshot.best_ask_size) > 0
    ? Number(snapshot.best_ask_size)
    : (Number(snapshot.depth_5_ask) > 0 && askPrice > 0 ? Number(snapshot.depth_5_ask) / askPrice : 0);

  return {
    bids: bidPrice > 0 && bidSize > 0 ? [[bidPrice, bidSize]] : [],
    asks: askPrice > 0 && askSize > 0 ? [[askPrice, askSize]] : [],
  };
}

async function main() {
  mkdirSync(paperDir, { recursive: true });

  const decisions = readJsonl(decisionsPath)
    .filter((item) => item?.type === 'BUY' || item?.type === 'SELL')
    .slice(-100);
  const trades = readJsonl(tradesPath);
  const tradeIndex = buildTradeIndex(trades);

  const comparisons = [];
  for (const decision of decisions) {
    const tokenId = decision.tokenId || decision.token_id;
    if (!tokenId || !decision.ts) continue;

    const actualPrice = decisionActualPrice(decision, tradeIndex);
    if (!(actualPrice > 0)) continue;

    const snapshot = await findNearestSnapshot(tokenId, decision.ts);
    if (!snapshot) continue;

    const simulated = simulateL2Fill({
      action: decision.type,
      token_id: tokenId,
      size_usd: Number(decision.spentUsd || decision.size_usd || decision.filled_usd || 0),
      max_slippage_bps: Number.POSITIVE_INFINITY,
    }, reconstructBook(snapshot));

    if (!(Number(simulated.avg_fill_price) > 0)) continue;

    const slippageBps = decision.type === 'SELL'
      ? ((Number(simulated.avg_fill_price) - actualPrice) / actualPrice) * 10000
      : ((actualPrice - Number(simulated.avg_fill_price)) / Number(simulated.avg_fill_price)) * 10000;

    comparisons.push({
      ts: decision.ts,
      token_id: tokenId,
      type: decision.type,
      actual_price: round(actualPrice, 6),
      simulated_price: round(simulated.avg_fill_price, 6),
      slippage_bps: round(slippageBps, 4),
      fill_ratio: round(simulated.fill_ratio, 6),
      snapshot_ts: snapshot.ts,
      snapshot_distance_ms: snapshotDistanceMs(snapshot.ts, decision.ts),
      simulation_status: simulated.status,
    });
  }

  const slippages = comparisons.map((item) => item.slippage_bps).filter(Number.isFinite);
  const fillRatios = comparisons.map((item) => item.fill_ratio).filter(Number.isFinite);
  const fillRatioDistribution = {
    full: comparisons.filter((item) => item.fill_ratio >= 0.999).length,
    partial: comparisons.filter((item) => item.fill_ratio > 0 && item.fill_ratio < 0.999).length,
    empty: comparisons.filter((item) => item.fill_ratio <= 0).length,
    median: median(fillRatios),
  };

  const report = {
    generated_at: new Date().toISOString(),
    sample_size: comparisons.length,
    source_decisions: decisions.length,
    median_slippage_bps: median(slippages),
    p90_slippage_bps: percentile(slippages, 90),
    fill_ratio_distribution: fillRatioDistribution,
    comparisons,
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`❌ Failed to evaluate fill quality: ${error.message}`);
  process.exit(1);
});

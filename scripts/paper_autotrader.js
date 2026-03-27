#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import minimist from 'minimist';
import { fetchPolyglobeIntel, matchPolyglobeIntel } from '../lib/polyglobe.js';
import { simulateL2Fill } from '../lib/l2_simulator.js';
import { initPositionMonitor, checkPositions } from '../lib/position_monitor.js';
import { SKILL_ROOT, buildReadonlyClient, normalizeMarketsResponse, normalizeMidpointResponse } from '../lib/runtime.js';
import { buildEvidenceBundle, enrichWithMemory } from '../lib/evidence_bundle.js';
import { runTradingAgentsPipeline } from '../lib/tradingagents_bridge.js';
import { storeReflection, generateReflection } from '../lib/agent_memory.js';
import { processNewPosition } from '../lib/foresight_extractor.js';

const execFileAsync = promisify(execFile);
const ALLOWED_TRADING_AGENT_SCRIPTS = new Set([
  resolve(SKILL_ROOT, 'scripts', 'llm_caller.js'),
]);
const args = minimist(process.argv.slice(2));
const once = Boolean(args.once);
const useTradingAgents = process.env.TRADING_AGENTS_ENABLED === '1' || Boolean(args['use-tradingagents']);

const followOnMode = Boolean(args.followOn);

// ─── Z-SCORE IMBALANCE (rolling window per token) ─────────────────────────────
const ZSCORE_WINDOW = 50;
let imbalanceWindows = {};
let imbalanceWindowsPath = null;

function loadImbalanceWindows() {
  try {
    if (imbalanceWindowsPath && existsSync(imbalanceWindowsPath)) {
      imbalanceWindows = JSON.parse(readFileSync(imbalanceWindowsPath, 'utf8'));
    }
  } catch { imbalanceWindows = {}; }
}
function saveImbalanceWindows() {
  try { if (imbalanceWindowsPath) writeFileSync(imbalanceWindowsPath, JSON.stringify(imbalanceWindows)); } catch {}
}
function updateAndGetZScore(tokenId, rawImbalance) {
  if (!Number.isFinite(rawImbalance)) return rawImbalance;
  if (!imbalanceWindows[tokenId]) imbalanceWindows[tokenId] = [];
  const w = imbalanceWindows[tokenId];
  w.push(rawImbalance);
  if (w.length > ZSCORE_WINDOW) w.splice(0, w.length - ZSCORE_WINDOW);
  if (w.length < 5) return rawImbalance;
  const mean = w.reduce((s, v) => s + v, 0) / w.length;
  const std = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / w.length);
  if (std < 0.01) return rawImbalance;
  return (rawImbalance - mean) / std;
}

// ─── MOMENTUM ARBITRAGE (CEX-to-PM price lag) ────────────────────────────────
let cexCachePath = null;
let cexMomentumCache = { price: null, change15m: 0, ts: 0 };

function loadCexCache() {
  try {
    if (cexCachePath && existsSync(cexCachePath)) {
      const data = JSON.parse(readFileSync(cexCachePath, 'utf8'));
      if (data && Array.isArray(data.prices) && data.prices.length > 0) {
        cexMomentumCache.ts = data.prices[data.prices.length - 1].ts;
      }
    }
  } catch {}
}
function saveCexCache(history) {
  try { if (cexCachePath) writeFileSync(cexCachePath, JSON.stringify({ prices: history })); } catch {}
}
function isCryptoMarket(question) {
  return /bitcoin|btc|crypto|ethereum|eth\b/i.test(question || '');
}
async function fetchBinanceBTC() {
  const now = Date.now();
  if (cexMomentumCache.price && (now - cexMomentumCache.ts) < 300000) return cexMomentumCache;
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return cexMomentumCache;
    const json = await res.json();
    const price = Number(json.price);
    if (!Number.isFinite(price)) return cexMomentumCache;
    let history = [];
    try { history = JSON.parse(readFileSync(cexCachePath, 'utf8')).prices || []; } catch {}
    history.push({ price, ts: now });
    history = history.filter(e => (now - e.ts) < 3600000);
    saveCexCache(history);
    const windowStart = now - 900000;
    const recent = history.filter(e => e.ts >= windowStart);
    if (recent.length >= 2) {
      const oldest = recent[0].price;
      cexMomentumCache = { price, change15m: oldest > 0 ? ((price - oldest) / oldest) * 100 : 0, ts: now };
    } else {
      cexMomentumCache = { price, change15m: 0, ts: now };
    }
    return cexMomentumCache;
  } catch { return cexMomentumCache; }
}

// ─── CATEGORY CLASSIFICATION & WEIGHTS ────────────────────────────────────────
function getCategory(question) {
  const q = (question || '').toLowerCase();
  if (/bitcoin|btc|crypto|ethereum|\beth\b|solana|token|airdrop/.test(q)) return 'crypto';
  if (/election|senate|governor|president|congress|parliament|mayor|primary/.test(q)) return 'politics';
  if (/\b(nba|nfl|mlb|nhl|soccer|football|championship|playoffs|world cup|ufc|boxing)\b/.test(q)) return 'sports';
  if (/war|conflict|military|nato|ukraine|israel|gaza|troops|missile|invasion|sanctions/.test(q)) return 'conflict';
  return 'other';
}
const categorizeQuestion = getCategory;
const CATEGORY_WEIGHTS = {
  politics: { imbalance: 1.2, mispricing: 1.5, spread: 0.8 },
  sports:   { imbalance: 0.8, mispricing: 0.5, spread: 1.3 },
  crypto:   { imbalance: 1.0, mispricing: 1.0, spread: 1.0, momentum: 1.5 },
  conflict: { imbalance: 1.0, mispricing: 1.2, spread: 0.9 },
  other:    { imbalance: 1.0, mispricing: 1.0, spread: 1.0 },
};

const intervalSec = followOnMode ? 0 : Math.max(60, parseInt(args.interval || 300, 10) || 300);

// ─── OUTPUT CONTRACT ───────────────────────────────────────────────────────────
// Structured decision schema enforced before every trade. Persists features
// alongside decisions for full auditability. Hard constraints override bad calls.
const HARD_CONSTRAINTS = {
  maxSpreadBps: 400,           // 4% spread → reject (was 6%)
  minImbalanceAbs: 0.10,       // weak signal → reject
  minScore: 0.5,               // selective but not impossible (was 0.7)
  maxSlippageBps: 60,          // L2 sim gate (wired by 5-4codex)
  minOrderbookDepthUsd: 3,     // minimum liquidity per side (was $2)
  maxCorrelatedPositions: 4,   // don't stack same-category bets
};

function validateDecision(candidate, features, state) {
  const violations = [];

  // Hard constraint: spread too wide
  if (features.spread * 10000 > HARD_CONSTRAINTS.maxSpreadBps) {
    violations.push(`spread ${Math.round(features.spread * 10000)} bps > ${HARD_CONSTRAINTS.maxSpreadBps}`);
  }
  // Hard constraint: weak imbalance signal (skip for AMM markets)
  if (!features.isAmm && Math.abs(features.imbalance) < HARD_CONSTRAINTS.minImbalanceAbs) {
    violations.push(`imbalance ${round2(features.imbalance)} < ${HARD_CONSTRAINTS.minImbalanceAbs}`);
  }
  // Hard constraint: low score
  if (candidate.score < HARD_CONSTRAINTS.minScore) {
    violations.push(`score ${round2(candidate.score)} < ${HARD_CONSTRAINTS.minScore}`);
  }
  // Hard constraint: insufficient depth
  const minDepth = Math.min(features.bidDepth, features.askDepth);
  if (minDepth * candidate.token.price < HARD_CONSTRAINTS.minOrderbookDepthUsd) {
    violations.push(`depth $${round2(minDepth * candidate.token.price)} < $${HARD_CONSTRAINTS.minOrderbookDepthUsd}`);
  }
  // Hard constraint: too many open positions
  if (state.openPositions.length >= state.maxPositions) {
    violations.push(`positions ${state.openPositions.length} >= max ${state.maxPositions}`);
  }
  // Hard constraint: insufficient cash
  const reserveUsd = state.risk?.reserveUsd || state.reserveUsd || 0;
  const deployableCash = round2(Math.max(0, state.cashUsd - reserveUsd));
  if (deployableCash < HARD_CONSTRAINTS.minOrderbookDepthUsd) {
    violations.push(`deployable $${deployableCash} insufficient`);
  }
  // Hard constraint: cross-market correlation (don't stack same-category bets)
  const candidateCat = getCategory(candidate?.market?.question || '');
  if (candidateCat !== 'other') {
    const sameCatCount = state.openPositions.filter(p => getCategory(p.question) === candidateCat).length;
    const categoryLimit = ['sports', 'conflict'].includes(candidateCat) ? 2 : HARD_CONSTRAINTS.maxCorrelatedPositions;
    if (sameCatCount >= categoryLimit) {
      violations.push(`correlated positions: ${sameCatCount} ${candidateCat} already open (max ${categoryLimit})`);
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    constraints: HARD_CONSTRAINTS,
    checkedAt: nowIso(),
  };
}

function buildDecisionRecord(candidate, action, tradeUsd, validation, manifoldEdge, l2Simulation = null) {
  const tradeUsdFilled = Number(l2Simulation?.filled_usd) > 0 ? Number(l2Simulation.filled_usd) : tradeUsd;
  const entryPrice = Number(l2Simulation?.avg_fill_price) > 0 ? Number(l2Simulation.avg_fill_price) : candidate.bestAsk;

  return {
    ts: nowIso(),
    type: action,                                  // BUY | HOLD | REJECT | SKIP
    action,                                        // legacy alias
    market_question: candidate.market.question,
    question: candidate.market.question,           // normalized for dashboard
    outcome: candidate.token.outcome,
    token_id: candidate.token.token_id,
    // Features at decision time (full auditability)
    features: {
      price: round2(candidate.token.price),
      spread: candidate.spread,
      spread_bps: Math.round(candidate.spread * 10000),
      bid_depth: round2(candidate.bidDepth),
      ask_depth: round2(candidate.askDepth),
      imbalance: round2(candidate.imbalance),
      score: round2(candidate.score),
      manifold_edge: manifoldEdge || null,
    },
    l2_simulation: l2Simulation,
    // Hard constraint check
    validation,
    // Trade params (if allowed)
    trade: action === 'BUY' ? {
      usd: round2(tradeUsdFilled),
      shares: round2(tradeUsdFilled / entryPrice),
      entry_price: round2(entryPrice),
    } : null,
  };
}
// ─── END OUTPUT CONTRACT ───────────────────────────────────────────────────────
const initialCad = Number(args['capital-cad'] || 20);
const maxPositions = Math.max(1, parseInt(args['max-positions'] || 5, 10) || 5);
const perTradePct = Number(args['per-trade-pct'] || 0.35);
const maxTradeUsd = Number(args['max-trade-usd'] || 15.0);
const minTradeUsd = Number(args['min-trade-usd'] || 1.0);
const takeProfitPct = Number(args['take-profit-pct'] || 0.1);
const stopLossPct = Number(args['stop-loss-pct'] || 0.05);
const maxHoldHours = Number(args['max-hold-hours'] || 3);
const reservePct = Number(args['reserve-pct'] || 0.7);
const maxDrawdownPct = Number(args['max-drawdown-pct'] || 0.15);
const maxDailyLossPct = Number(args['max-daily-loss-pct'] || 0.15);
const maxConsecutiveLosses = Math.max(1, parseInt(args['max-consecutive-losses'] || 6, 10) || 6);

const paperDir = resolve(SKILL_ROOT, 'memory', 'paper');
const accountPath = resolve(paperDir, 'account.json');
const decisionsPath = resolve(paperDir, 'decisions.jsonl');
const tradesPath = resolve(paperDir, 'trades.jsonl');
const snapshotsPath = resolve(paperDir, 'snapshots.jsonl');
const regimeStatesPath = resolve(paperDir, 'regime_states.jsonl');
const dexReviewPath = resolve(paperDir, 'dex_review.json');
const tradingAgentsDecisionsPath = resolve(paperDir, 'decision_bundles.jsonl');

mkdirSync(paperDir, { recursive: true });
imbalanceWindowsPath = resolve(paperDir, 'imbalance_windows.json');
cexCachePath = resolve(paperDir, 'cex_cache.json');
loadImbalanceWindows();
loadCexCache();

const client = buildReadonlyClient();
let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finiteOrNull = (value, digits = 2) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return digits === 4 ? round4(numeric) : round2(numeric);
};

function appendJsonl(filePath, obj) {
  appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function readAccount() {
  if (!existsSync(accountPath)) return null;
  return JSON.parse(readFileSync(accountPath, 'utf8'));
}

function writeAccount(state) {
  writeFileSync(accountPath, JSON.stringify(state, null, 2));
}

async function fetchCadUsd() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/CAD');
    if (res.ok) {
      const json = await res.json();
      const rate = Number(json?.rates?.USD);
      if (Number.isFinite(rate) && rate > 0) return rate;
    }
  } catch {}
  return 0.70;
}

function getTodayRealizedLoss(state) {
  const today = nowIso().slice(0, 10);
  return round2(
    state.closedPositions
      .filter((p) => String(p.closedAt || '').slice(0, 10) === today && Number(p.pnlUsd) < 0)
      .reduce((sum, p) => sum + Math.abs(Number(p.pnlUsd || 0)), 0)
  );
}

function getConsecutiveLosses(state) {
  let losses = 0;
  for (let i = state.closedPositions.length - 1; i >= 0; i -= 1) {
    const pnl = Number(state.closedPositions[i].pnlUsd || 0);
    if (pnl < 0) losses += 1;
    else break;
  }
  return losses;
}

function getOpenValue(state) {
  return round2(state.openPositions.reduce((sum, p) => sum + p.shares * (p.lastMarkPrice || p.entryPrice), 0));
}

function getEquity(state) {
  return round2(state.cashUsd + getOpenValue(state));
}

function updateRiskState(state) {
  if (!state.risk) {
    state.risk = {
      paused: false,
      pauseReason: null,
      reserveUsd: round2(state.initialUsd * reservePct),
      maxDrawdownUsd: round2(state.initialUsd * maxDrawdownPct),
      maxDailyLossUsd: round2(getEquity(state) * maxDailyLossPct),
      maxConsecutiveLosses,
    };
  }

  const equity = getEquity(state);
  state.risk.maxDailyLossUsd = round2(equity * maxDailyLossPct);  // Scale with equity
  const drawdownUsd = round2(Math.max(0, state.initialUsd - equity));
  const todayLossUsd = getTodayRealizedLoss(state);
  const consecutiveLosses = getConsecutiveLosses(state);

  let pauseReason = null;
  if (state.openPositions.length > maxPositions) pauseReason = 'POSITION_CAP_EXCEEDED';
  else if (drawdownUsd >= state.risk.maxDrawdownUsd) pauseReason = 'MAX_DRAWDOWN';
  else if (todayLossUsd >= state.risk.maxDailyLossUsd) pauseReason = 'MAX_DAILY_LOSS';
  else if (consecutiveLosses >= state.risk.maxConsecutiveLosses) pauseReason = 'MAX_CONSECUTIVE_LOSSES';

  const wasPaused = state.risk.paused;
  state.risk.paused = Boolean(pauseReason);
  state.risk.pauseReason = pauseReason;
  state.risk.lastComputed = nowIso();
  state.risk.equityUsd = equity;
  state.risk.drawdownUsd = drawdownUsd;
  state.risk.todayLossUsd = todayLossUsd;
  state.risk.consecutiveLosses = consecutiveLosses;

  // Call Dex when risk engine pauses
  if (pauseReason && !wasPaused) {
    try { execFileSync('node', [resolve(SCRIPTS_DIR, 'call_dex.js'), `Trader paused: ${pauseReason} (${consecutiveLosses} losses, drawdown $${drawdownUsd})`], { timeout: 10000, env: { ...process.env, CALLER: 'trader' } }); } catch {}
  }

  return state.risk;
}

async function loadOrInitAccount() {
  const existing = readAccount();
  if (existing) {
    existing.strategy = {
      name: 'orderbook-imbalance-scalper',
      intervalSec,
      maxPositions,
      perTradePct,
      maxTradeUsd,
      minTradeUsd,
      takeProfitPct,
      stopLossPct,
      maxHoldHours,
      reservePct,
      maxDrawdownPct,
      maxDailyLossPct,
      maxConsecutiveLosses,
    };
    existing.risk = {
      ...(existing.risk || {}),
      paused: false,
      pauseReason: null,
      reserveUsd: round2(existing.initialUsd * reservePct),
      maxDrawdownUsd: round2(existing.initialUsd * maxDrawdownPct),
      maxDailyLossUsd: round2((existing.cashUsd + (existing.openPositions || []).reduce((s, p) => s + (p.shares || 0) * (p.lastMarkPrice || p.entryPrice || 0), 0)) * maxDailyLossPct),
      maxConsecutiveLosses,
    };
    updateRiskState(existing);
    writeAccount(existing);
    return existing;
  }

  const fxCadUsd = await fetchCadUsd();
  const initialUsd = round2(initialCad * fxCadUsd);
  const state = {
    mode: 'paper',
    createdAt: nowIso(),
    initialCad: round2(initialCad),
    fxCadUsd: round2(fxCadUsd),
    initialUsd,
    cashUsd: initialUsd,
    realizedPnlUsd: 0,
    openPositions: [],
    closedPositions: [],
    decisionCount: 0,
    cycleCount: 0,
    lastCycleAt: null,
    strategy: {
      name: 'orderbook-imbalance-scalper',
      intervalSec,
      maxPositions,
      perTradePct,
      maxTradeUsd,
      minTradeUsd,
      takeProfitPct,
      stopLossPct,
      maxHoldHours,
      reservePct,
      maxDrawdownPct,
      maxDailyLossPct,
      maxConsecutiveLosses,
    },
    risk: {
      paused: false,
      pauseReason: null,
      reserveUsd: round2(initialUsd * reservePct),
      maxDrawdownUsd: round2(initialUsd * maxDrawdownPct),
      maxDailyLossUsd: round2(initialUsd * maxDailyLossPct),
      maxConsecutiveLosses,
    },
  };

  writeAccount(state);
  appendJsonl(decisionsPath, {
    ts: nowIso(),
    type: 'INIT',
    note: 'Paper trading account created',
    bankroll: { cad: state.initialCad, usd: state.initialUsd, fxCadUsd: state.fxCadUsd },
  });
  return state;
}

function getBestBid(book) {
  return Math.max(...(book?.bids || []).map((x) => Number(x.price)).filter(Number.isFinite), 0);
}

function getBestAsk(book) {
  const asks = (book?.asks || []).map((x) => Number(x.price)).filter(Number.isFinite);
  return asks.length ? Math.min(...asks) : null;
}

function sumDepth(levels, predicate) {
  return round2((levels || []).reduce((sum, lvl) => sum + (predicate(Number(lvl.price)) ? Number(lvl.size || 0) : 0), 0));
}

async function getLiveMarkets() {
  const markets = normalizeMarketsResponse(await client.getSamplingMarkets());
  return markets.filter((m) => m.active && !m.closed && m.accepting_orders && m.enable_order_book && Array.isArray(m.tokens) && m.tokens.length >= 2);
}

async function markPosition(position) {
  try {
    const raw = await client.getMidpoint(position.tokenId);
    if (raw && typeof raw === 'object' && raw.error) return position.lastMarkPrice ?? position.entryPrice;
    const mid = Number(normalizeMidpointResponse(raw));
    return Number.isFinite(mid) && mid > 0 ? mid : (position.lastMarkPrice ?? position.entryPrice);
  } catch {
    return position.lastMarkPrice ?? position.entryPrice;
  }
}

function bucketValue(value, bounds, labels) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return labels[labels.length - 1];
  for (let i = 0; i < bounds.length; i += 1) {
    if (numeric <= bounds[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

function buildStateLabel(state) {
  return [
    `p:${state.priceBucket}`,
    `s:${state.spreadBucket}`,
    `i:${state.imbalanceBucket}`,
    `a:${state.ageBucket}`,
    `m:${state.markChangeBucket}`,
  ].join('|');
}

function buildCoarseStateLabel(state) {
  return [
    `p:${state.priceBucket}`,
    `s:${state.spreadBucket}`,
    `i:${state.imbalanceBucket}`,
    `m:${state.markChangeBucket}`,
  ].join('|');
}

function recordRegimeState({
  position = null,
  market = null,
  token = null,
  cycle = null,
  status,
  currentPrice = null,
  spread = null,
  bidDepth = null,
  askDepth = null,
  imbalance = null,
  score = null,
  note = null,
  realizedPnlUsd = null,
  polyglobe = null,
}) {
  const price = Number.isFinite(Number(currentPrice))
    ? Number(currentPrice)
    : Number(position?.lastMarkPrice ?? position?.entryPrice ?? token?.price ?? 0);
  const ageHours = position ? (Date.now() - new Date(position.openedAt).getTime()) / 3600000 : 0;
  const entryPrice = Number(position?.entryPrice ?? price ?? 0);
  const markChangePct = entryPrice > 0 && Number.isFinite(price)
    ? ((price - entryPrice) / entryPrice)
    : 0;
  const tokenId = position?.tokenId || token?.token_id || null;
  const episodeKey = position?.id || (tokenId ? `watch:${tokenId}` : null);

  const state = {
    schemaVersion: 2,
    ts: nowIso(),
    cycle: Number.isFinite(Number(cycle)) ? Number(cycle) : null,
    tokenId,
    marketId: position?.marketId || market?.condition_id || null,
    positionId: position?.id || null,
    episodeKey,
    question: market?.question || position?.question || null,
    outcome: position?.outcome || token?.outcome || null,
    price: finiteOrNull(price),
    spread: finiteOrNull(spread),
    bidDepth: finiteOrNull(bidDepth),
    askDepth: finiteOrNull(askDepth),
    imbalance: finiteOrNull(imbalance, 4),
    ageHours: finiteOrNull(ageHours),
    hoursToMaxHold: finiteOrNull(Math.max(0, maxHoldHours - ageHours)),
    status,
    score: finiteOrNull(score, 4),
    entryPrice: finiteOrNull(entryPrice),
    markChangePct: finiteOrNull(markChangePct, 4),
    unrealizedPnlUsd: position && Number.isFinite(price) ? round2(position.shares * price - position.costUsd) : null,
    realizedPnlUsd: finiteOrNull(realizedPnlUsd),
    polyglobeBreaking: Boolean(polyglobe?.isBreaking),
    polyglobePriceMovement24h: finiteOrNull(polyglobe?.priceMovement24h, 4),
    polyglobeVolume24h: finiteOrNull(polyglobe?.volume24h),
    polyglobeLocationCount: finiteOrNull(polyglobe?.locationCount),
    polyglobeLatestPrice: finiteOrNull(polyglobe?.latestPrice, 4),
    polyglobeFreshnessMatchedMin: finiteOrNull(polyglobe?.freshnessMinutes?.latestMatchedTweet, 4),
    polyglobeFreshnessTruthMin: finiteOrNull(polyglobe?.freshnessMinutes?.latestTruth, 4),
    note,
  };

  state.priceBucket = bucketValue(state.price, [0.2, 0.4, 0.6, 0.8], ['p0', 'p1', 'p2', 'p3', 'p4']);
  state.spreadBucket = bucketValue(state.spread, [0.01, 0.02, 0.05], ['s0', 's1', 's2', 's3']);
  state.imbalanceBucket = bucketValue(state.imbalance, [-0.25, 0, 0.25, 0.5], ['i0', 'i1', 'i2', 'i3', 'i4']);
  state.ageBucket = bucketValue(state.ageHours, [0.5, 1, 3, 6], ['a0', 'a1', 'a2', 'a3', 'a4']);
  state.markChangeBucket = bucketValue(state.markChangePct, [-0.1, -0.03, 0.03, 0.1], ['m0', 'm1', 'm2', 'm3', 'm4']);
  state.stateLabel = buildStateLabel(state);
  state.modelStateLabel = state.stateLabel;
  state.coarseStateLabel = buildCoarseStateLabel(state);

  appendJsonl(regimeStatesPath, state);
}

async function fetchOrderBookFeatures(tokenId) {
  try {
    const book = await client.getOrderBook(tokenId);
    if (!book || typeof book !== 'object' || book.error) return null;
    const bestBid = getBestBid(book);
    const bestAsk = getBestAsk(book);
    if (!bestBid || !bestAsk || bestAsk <= bestBid) return null;

    const spread = round2(bestAsk - bestBid);
    const bidDepth = sumDepth(book.bids, (p) => p >= bestBid - 0.02);
    const askDepth = sumDepth(book.asks, (p) => p <= bestAsk + 0.02);
    const totalDepth = bidDepth + askDepth;
    const imbalance = totalDepth ? (bidDepth - askDepth) / totalDepth : 0;

    return { bestBid, bestAsk, spread, bidDepth, askDepth, imbalance, book };
  } catch {
    return null;
  }
}

async function closePosition(state, position, exitPrice, reason) {
  console.log(`[EXIT] ${position.question?.slice(0,40)} | ${reason} | entry=${position.entryPrice} exit=${exitPrice} pnl=${round2(position.shares * exitPrice - position.costUsd)}`);
  const proceedsUsd = round2(position.shares * exitPrice);
  const pnlUsd = round2(proceedsUsd - position.costUsd);
  recordRegimeState({
    position,
    cycle: state.cycleCount + 1,
    status: 'closed',
    currentPrice: exitPrice,
    note: reason,
    realizedPnlUsd: pnlUsd,
  });
  state.cashUsd = round2(state.cashUsd + proceedsUsd);
  state.realizedPnlUsd = round2(state.realizedPnlUsd + pnlUsd);
  state.openPositions = state.openPositions.filter((p) => p.id !== position.id);
  state.closedPositions.push({
    ...position,
    closedAt: nowIso(),
    exitPrice: round2(exitPrice),
    proceedsUsd,
    pnlUsd,
    result: pnlUsd > 0 ? 'right' : pnlUsd < 0 ? 'wrong' : 'flat',
    exitReason: reason,
  });
  appendJsonl(tradesPath, {
    ts: nowIso(),
    type: 'EXIT',
    tokenId: position.tokenId,
    question: position.question,
    outcome: position.outcome,
    entryPrice: position.entryPrice,
    exitPrice: round2(exitPrice),
    costUsd: position.costUsd,
    proceedsUsd,
    pnlUsd,
    result: pnlUsd > 0 ? 'right' : pnlUsd < 0 ? 'wrong' : 'flat',
    reason,
  });
  const placeholderReflection = {
    marketQuestion: position.question,
    category: getCategory(position.question),
    side: position.outcome,
    entryPrice: round2(position.entryPrice),
    exitPrice: round2(exitPrice),
    exitReason: reason,
    pnlUsd,
    result: pnlUsd > 0 ? 'good' : 'bad',
    roleDecisions: position?.rationale?.tradingAgentsDecision?.performanceSnapshot?.roleDecisions || {},
    roleOutputs: position?.rationale?.tradingAgentsDecision?.roleOutputs || {},
  };
  storeReflection(placeholderReflection);

  if (Math.abs(pnlUsd) > 0.50 && position?.rationale?.tradingAgentsDecision) {
    const closedTrade = {
      ...position,
      question: position.question,
      category: getCategory(position.question),
      pnlUsd,
      exitPrice: round2(exitPrice),
      exitReason: reason,
      roleDecisions: placeholderReflection.roleDecisions,
      roleOutputs: placeholderReflection.roleOutputs,
    };
    const entryBundle = position?.rationale?.tradingAgentsDecision?.entryBundle || position?.rationale?.entryBundle || {};
    setImmediate(() => {
      Promise.resolve()
        .then(() => generateReflection(closedTrade, entryBundle, { exitPrice: round2(exitPrice), reason, pnlUsd }))
        .catch((error) => {
          appendJsonl(decisionsPath, {
            ts: nowIso(),
            type: 'REFLECTION_ERROR',
            question: position.question,
            tokenId: position.tokenId,
            error: error.message,
          });
        });
    });
  }
}

async function buildCandidateFromMarket(state, market, token, polyglobeIntel = null) {
  const features = await fetchOrderBookFeatures(token.token_id);

  let entryFeatures;
  if (features && features.spread < 0.10) {
    const ammPrice = Number(token.price);
    const askToAmmRatio = Number.isFinite(ammPrice) && ammPrice > 0 ? features.bestAsk / ammPrice : 1;
    if (askToAmmRatio > 3) {
      console.log(`[amm-fallback] ${market.question?.slice(0,40)} | ask=${features.bestAsk} amm=${ammPrice} ratio=${askToAmmRatio.toFixed(1)}x`);
      entryFeatures = {
        spread: 0.02,
        bidDepth: 1000,
        askDepth: 1000,
        imbalance: 0,
        isAmm: true,
        ammGap: Number.isFinite(ammPrice) ? round4(features.bestAsk - ammPrice) : 0,
      };
    } else {
      entryFeatures = { ...features, isAmm: false, ammGap: Number.isFinite(ammPrice) ? round4(features.bestAsk - ammPrice) : 0 };
      if (askToAmmRatio > 2) console.log(`[ob-used] ${market.question?.slice(0,40)} | ask=${features.bestAsk} amm=${ammPrice} ratio=${askToAmmRatio.toFixed(1)}x`);
    }
  } else {
    const price = Number(token.price);
    if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
    entryFeatures = {
      spread: 0.02,
      bidDepth: 1000,
      askDepth: 1000,
      imbalance: 0,
      isAmm: true,
      ammGap: 0,
    };
  }

  if (entryFeatures.spread > 0.06) return null;

  const category = getCategory(market.question);
  const weights = CATEGORY_WEIGHTS[category] || CATEGORY_WEIGHTS.other;

  let imbalanceSignal = entryFeatures.imbalance;
  if (!entryFeatures.isAmm && Number.isFinite(entryFeatures.imbalance)) {
    imbalanceSignal = updateAndGetZScore(token.token_id, entryFeatures.imbalance);
  }

  const priceUpside = Math.min(Number(token.price), 1 - Number(token.price));
  const upsideBonus = (0.5 - priceUpside) * 0.3;
  let score;
  if (entryFeatures.isAmm) {
    score = upsideBonus + 0.1;
  } else {
    const imbalanceComponent = Math.abs(entryFeatures.imbalance) * weights.imbalance;
    const spreadComponent = -entryFeatures.spread * 6 * weights.spread;
    score = imbalanceComponent + spreadComponent + upsideBonus;
    if (Math.abs(entryFeatures.imbalance) < 0.10 && Math.abs(imbalanceSignal) < 1.5) return null;
  }

  let momentumBonus = 0;
  let binanceData = null;
  if (isCryptoMarket(market.question)) {
    const cex = await fetchBinanceBTC();
    if (Number.isFinite(cex.change15m) && Math.abs(cex.change15m) > 2) {
      momentumBonus = Math.abs(cex.change15m) * 0.15 * (weights.momentum || 1);
      score += momentumBonus;
    }
    binanceData = {
      price: cex.price,
      return15s: cex.change15m,
      vol30s: null,
      updatedAt: cex.ts,
    };
  }

  let manifoldEdge = null;
  let mispricingBonus = 0;
  // Manifold matching DISABLED — 0/5 profitable, matches unrelated questions.
  // Re-enable only with NLP semantic similarity (cosine > 0.9 on sentence embeddings).
  // if (manifold && manifold.volume > 50) {
  //   const polyPrice = Number(token.price);
  //   const manifoldProb = manifold.prob;
  //   const gap = Math.abs(polyPrice - manifoldProb);
  //   if (gap > 0.10) {
  //     mispricingBonus = gap * 0.8 * weights.mispricing;
  //     score += mispricingBonus;
  //     manifoldEdge = {
  //       manifoldProb: round4(manifoldProb),
  //       polyPrice: round4(polyPrice),
  //       gap: round4(gap),
  //       manifoldQuestion: manifold.question,
  //       manifoldVolume: round2(manifold.volume),
  //     };
  //   }
  // }

  return {
    market,
    token,
    ...entryFeatures,
    category,
    score,
    imbalanceZ: imbalanceSignal,
    momentumBonus,
    mispricingBonus,
    binanceData,
    polyglobe: matchPolyglobeIntel(market, polyglobeIntel),
    manifoldEdge,
  };
}

async function evaluateEntries(state, liveMarkets, polyglobeIntel = null) {
  const risk = updateRiskState(state);
  const deployableCash = round2(Math.max(0, state.cashUsd - risk.reserveUsd));
  if (risk.paused) return null;
  if (state.openPositions.length >= maxPositions || deployableCash < minTradeUsd) return null;

  const held = new Set(state.openPositions.map((p) => p.tokenId));
  const nowMs = Date.now();
  const maxEndDays = 30;
  // Load market-specific avoid list from Dex review
  const dexAvoidMarkets = (loadDexReview()?.entryGuidance?.avoidMarkets || []).map((s) => String(s).toLowerCase());
  const shortlist = liveMarkets
    .map((market) => {
      // Pick the cheapest valid token (highest upside potential) — NOT the one closest to 0.5
    const token = [...market.tokens]
      .filter(t => {
        const p = Number(t.price);
        return Number.isFinite(p) && p >= 0.01 && p <= 0.99;
      })
      .sort((a, b) => Number(a.price) - Number(b.price))[0]; // cheapest = most upside
      return { market, token };
    })
    .filter(({ token, market }) => {
      if (!token || held.has(token.token_id)) return false;
      if (Number(token.price) < 0.01 || Number(token.price) > 0.99) return false;
      // Skip markets explicitly flagged by Dex review
      const q = String(market.question || '').toLowerCase();
      if (dexAvoidMarkets.some((avoid) => q.includes(avoid) || avoid.includes(q))) return false;
      // Skip markets ending more than 30 days out — too stable for a scalper
      if (market.end_date_iso) {
        const daysToEnd = (new Date(market.end_date_iso).getTime() - nowMs) / 86400000;
        if (daysToEnd > maxEndDays) return false;
      }
      // Market maturity filter: skip very new markets (< 2 hours old) — only check if data available
      if (market.start_date_iso) {
        const ageHours = (nowMs - new Date(market.start_date_iso).getTime()) / 3600000;
        if (ageHours < 2) return false;
      }
      // Liquidity filter: skip thin markets (< $500 liquidity) — only check if data available
      const liq = Number(market.liquidity);
      if (Number.isFinite(liq) && liq < 500) return false;
      return true;
    })
    .slice(0, 25);

  const scored = [];
  for (const { market, token } of shortlist) {
    const candidate = await buildCandidateFromMarket(state, market, token, polyglobeIntel);
    if (candidate) scored.push(candidate);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function resolveTradingAgentsScript() {
  const configuredPath = process.env.TRADING_AGENTS_LLM_SCRIPT;
  if (!configuredPath) {
    throw new Error('TRADING_AGENTS_LLM_SCRIPT not set');
  }
  if (configuredPath.startsWith('/') || configuredPath.includes('..')) {
    throw new Error('TRADING_AGENTS_LLM_SCRIPT must be a repo-relative allowlisted script');
  }

  const resolvedPath = resolve(SKILL_ROOT, configuredPath);
  if (!ALLOWED_TRADING_AGENT_SCRIPTS.has(resolvedPath)) {
    throw new Error(`TRADING_AGENTS_LLM_SCRIPT is not allowlisted: ${configuredPath}`);
  }

  return resolvedPath;
}

async function callTradingAgentsLlm(messages) {
  const scriptPath = resolveTradingAgentsScript();
  const childEnv = { ...process.env };
  delete childEnv.PRIVATE_KEY;

  const stdout = execFileSync('node', [scriptPath], {
    input: JSON.stringify(messages),
    encoding: 'utf8',
    timeout: Number(process.env.TRADING_AGENTS_LLM_TIMEOUT_MS || 120000),
    maxBuffer: 2 * 1024 * 1024,
    env: childEnv,
  });
  return String(stdout || '').trim();
}

function loadDexReview() {
  if (!existsSync(dexReviewPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(dexReviewPath, 'utf8'));
    // Expire review after 30 minutes
    const age = (Date.now() - new Date(raw.ts).getTime()) / 60000;
    if (age > 30) return null;
    return raw;
  } catch { return null; }
}

async function runCycle(state) {
  const cycle = state.cycleCount + 1;
  const polyglobeIntel = await fetchPolyglobeIntel();
  const liveMarkets = await getLiveMarkets();
  const liveMap = new Map(liveMarkets.flatMap((market) => market.tokens.map((token) => [token.token_id, { market, token }])));
  const dexReview = loadDexReview();

  for (const position of [...state.openPositions]) {
    const currentPrice = round2(await markPosition(position));
    position.lastMarkPrice = currentPrice;
    position.highWaterPrice = Math.max(position.highWaterPrice || position.entryPrice, currentPrice);

    // Record regime state for non-exited positions (exit logic handled by checkPositions below)
    const ref = liveMap.get(position.tokenId);
    const features = await fetchOrderBookFeatures(position.tokenId);
    const polyglobe = ref?.market ? matchPolyglobeIntel(ref.market, polyglobeIntel) : null;
    recordRegimeState({
      position,
      market: ref?.market,
      token: ref?.token,
      cycle,
      status: 'open',
      currentPrice,
      spread: features?.spread,
      bidDepth: features?.bidDepth,
      askDepth: features?.askDepth,
      imbalance: features?.imbalance,
      polyglobe,
      note: ref ? 'Position still live' : 'Position held without fresh market metadata',
    });
  }

  // Exit logic consolidated here — checkPositions handles TP/SL/trailing/time-exit/dex-advisory
  await checkPositions(state, { client, decisionsPath, takeProfitPct, stopLossPct, maxHoldHours, liveMap, dexReview });

  const risk = updateRiskState(state);
  const candidate = await evaluateEntries(state, liveMarkets, polyglobeIntel);
  if (risk.paused) {
    appendJsonl(decisionsPath, {
      ts: nowIso(),
      type: 'PAUSE',
      reason: risk.pauseReason,
      equityUsd: risk.equityUsd,
      drawdownUsd: risk.drawdownUsd,
      todayLossUsd: risk.todayLossUsd,
      consecutiveLosses: risk.consecutiveLosses,
    });
  } else if (candidate && candidate.score >= 0.15 && dexReview?.verdict !== 'BLOCKED') {
    const avoided = dexReview?.entryGuidance?.avoidCategories || [];
    const candidateCat = candidate.market?.groupItemTitle || candidate.market?.category || '';
    const isAvoided = avoided.some((cat) => candidateCat.toLowerCase().includes(cat.toLowerCase()) || (candidate.market?.question || '').toLowerCase().includes(cat.toLowerCase()));

    if (isAvoided) {
      appendJsonl(decisionsPath, { ts: nowIso(), type: 'SKIP', question: candidate.market.question, note: 'Dex review: avoided category' });
    } else {
      recordRegimeState({
        position: null,
        market: candidate.market,
        token: candidate.token,
        cycle,
        status: 'candidate',
        currentPrice: Number(candidate.token.price),
        spread: candidate.spread,
        bidDepth: candidate.bidDepth,
        askDepth: candidate.askDepth,
        imbalance: candidate.imbalance,
        score: candidate.score,
        polyglobe: candidate.polyglobe,
        note: 'Candidate passed conservative filters',
      });

      const deployableCash = round2(Math.max(0, state.cashUsd - risk.reserveUsd));
      let tradeUsd = round2(Math.min(maxTradeUsd, Math.max(minTradeUsd, deployableCash * perTradePct)));
      if (candidate.token.price < 0.05) tradeUsd = round2(Math.max(minTradeUsd, tradeUsd * 0.5));

      const features = {
        spread: candidate.spread,
        imbalance: candidate.imbalance,
        bidDepth: candidate.bidDepth,
        askDepth: candidate.askDepth,
      };
      const validation = validateDecision(candidate, features, state);

      if (!validation.allowed) {
        const record = buildDecisionRecord(candidate, 'REJECT', 0, validation, candidate.manifoldEdge);
        appendJsonl(decisionsPath, record);
        console.log(`🚫 REJECT: ${candidate.market.question.slice(0, 50)}... | ${validation.violations.join(', ')}`);
      } else if (deployableCash >= tradeUsd && tradeUsd >= minTradeUsd) {
        let taBlocked = false;
        let tradingAgentsDecision = null;

        if (useTradingAgents) {
          try {
            const evidenceBundle = buildEvidenceBundle(candidate, {
              liveMarkets,
              polyglobeIntel,
              manifoldRefs: candidate.manifoldEdge ? [candidate.manifoldEdge] : [],
              risk: state.risk,
              account: { ...state, maxPositions },
              maxPositions,
            }, {
              binanceData: candidate.binanceData,
              contextSnippets: [],
            });

            // Enrich with memory context from atomic facts, foresights, agent profiles, clusters
            const enrichedBundle = await enrichWithMemory(evidenceBundle);

            tradingAgentsDecision = await runTradingAgentsPipeline(enrichedBundle, {
              llmCallFn: callTradingAgentsLlm,
            });
            tradingAgentsDecision.entryBundle = enrichedBundle;

            if (!['APPROVE', 'REDUCE'].includes(tradingAgentsDecision.decision)) {
              taBlocked = true;
              appendJsonl(decisionsPath, {
                ts: nowIso(),
                type: 'SKIP',
                question: candidate.market.question,
                outcome: candidate.token.outcome,
                note: `TradingAgents ${tradingAgentsDecision.decision || 'SKIP'}`,
                tradingAgentsDecision,
              });
            } else if (tradingAgentsDecision.decision === 'REDUCE') {
              const reduced = Number(tradingAgentsDecision.finalProposal?.final_size_usd);
              if (Number.isFinite(reduced) && reduced > 0) {
                tradeUsd = round2(Math.max(minTradeUsd, Math.min(tradeUsd, reduced)));
              }
            }
          } catch (error) {
            taBlocked = true;
            appendJsonl(decisionsPath, {
              ts: nowIso(),
              type: 'TA_ERROR',
              question: candidate.market.question,
              error: error.message,
            });
          }
        }

        if (!taBlocked) {
          let l2Simulation = null;
          if (candidate.isAmm) {
            l2Simulation = {
              status: 'amm_fill',
              avg_fill_price: Number(candidate.token.price),
              filled_usd: tradeUsd,
              slippage_bps: 0,
              fill_ratio: 1,
            };
          } else {
            l2Simulation = simulateL2Fill({
              action: 'BUY',
              token_id: candidate.token.token_id,
              size_usd: tradeUsd,
              max_slippage_bps: HARD_CONSTRAINTS.maxSlippageBps,
            }, {
              bids: candidate.book?.bids || [],
              asks: candidate.book?.asks || [],
            });
          }

          const ammMid = Number(candidate.token.price);
          const fillPrice = Number(l2Simulation.avg_fill_price);
          const absGap = Number.isFinite(ammMid) && Number.isFinite(fillPrice) ? fillPrice - ammMid : 0;
          const fillRatio = Number.isFinite(ammMid) && ammMid > 0 ? fillPrice / ammMid : 1;
          let useAmmPrice = candidate.isAmm;

          if (!useAmmPrice && absGap > 0.05 && fillRatio > 1.5) {
            console.log(`[AMM-SWAP] ${candidate.market.question?.slice(0,40)} | L2 fill=${fillPrice} >> AMM=${ammMid} (${fillRatio.toFixed(1)}x) → using AMM price`);
            // Realistic market impact: on thin Polymarket markets, your order IS the market
            // Small bets ($1-2) → ~1% impact, medium ($5-10) → ~2-3%, large ($10-15) → ~3-5%
            const impactPct = 0.01 + (tradeUsd / 10) * 0.025; // $1 → 1.25%, $5 → 2.25%, $10 → 3.5%, $15 → 4.75%
            const gasCostBps = tradeUsd > 0 ? (0.01 / tradeUsd) * 10000 : 0;
            const totalCostBps = impactPct * 10000 + gasCostBps;
            const ammAdjusted = ammMid * (1 + totalCostBps / 10000);
            l2Simulation = {
              status: 'amm_swap',
              avg_fill_price: round2(ammAdjusted),
              filled_usd: tradeUsd,
              slippage_bps: round2(impactPct * 10000),
              gas_bps: gasCostBps,
              fill_ratio: 1,
            };
            useAmmPrice = true;
          }

          if (l2Simulation.status === 'rejected_slippage' || l2Simulation.status === 'no_depth' || Number(l2Simulation.fill_ratio || 0) <= 0) {
            const l2Validation = {
              ...validation,
              allowed: false,
              violations: [...validation.violations, `l2 ${l2Simulation.status} @ ${round2(l2Simulation.slippage_bps || 0)} bps`],
            };
            appendJsonl(decisionsPath, {
              ...buildDecisionRecord(candidate, 'REJECT', tradeUsd, l2Validation, candidate.manifoldEdge, l2Simulation),
              type: 'REJECT',
              tokenId: candidate.token.token_id,
              question: candidate.market.question,
              outcome: candidate.token.outcome,
              note: 'L2 gate rejected BUY',
            });
          } else {
            const entryPrice = useAmmPrice
              ? round2(Number(candidate.token.price))
              : round2(l2Simulation.avg_fill_price || candidate.bestAsk);
            const filledUsd = round2(Number(l2Simulation.filled_usd) || tradeUsd);
            const shares = round2(filledUsd / entryPrice);
            const position = {
              id: `paper-${Date.now()}`,
              openedAt: nowIso(),
              tokenId: candidate.token.token_id,
              marketId: candidate.market.condition_id,
              question: candidate.market.question,
              outcome: candidate.token.outcome,
              entryPrice,
              shares,
              costUsd: filledUsd,
              lastMarkPrice: round2(candidate.token.price),
              highWaterPrice: round2(candidate.token.price),
              rationale: {
                spread: candidate.spread,
                bidDepth: candidate.bidDepth,
                askDepth: candidate.askDepth,
                imbalance: round2(candidate.imbalance),
                score: round2(candidate.score),
                manifoldEdge: candidate.manifoldEdge || null,
                l2Simulation,
                tradingAgentsDecision,
              },
            };

            state.cashUsd = round2(state.cashUsd - position.costUsd);
            state.openPositions.push(position);

            // Generate foresight predictions for this position (background, non-blocking)
            const foresightPos = { ...position, category: categorizeQuestion(position.question), score: position.rationale.score, spread: position.rationale.spread, imbalance: position.rationale.imbalance };
            const foresightCtx = { category: categorizeQuestion(position.question) };
            processNewPosition(foresightPos, foresightCtx).catch((err) => {
              console.error('[foresight] generation failed:', err.message);
            });

            appendJsonl(tradesPath, {
              ts: nowIso(),
              type: 'ENTRY',
              tokenId: position.tokenId,
              question: position.question,
              outcome: position.outcome,
              entryPrice: position.entryPrice,
              shares: position.shares,
              costUsd: position.costUsd,
              rationale: position.rationale,
            });
            appendJsonl(decisionsPath, {
              ...buildDecisionRecord(candidate, 'BUY', tradeUsd, validation, candidate.manifoldEdge, l2Simulation),
              type: 'BUY',
              tokenId: position.tokenId,
              question: position.question,
              outcome: position.outcome,
              spentUsd: position.costUsd,
              spentCadApprox: round2(position.costUsd / state.fxCadUsd),
              entryPrice: position.entryPrice,
              l2Simulation,
              tradingAgentsDecision,
              rationale: `Orderbook imbalance ${position.rationale.imbalance}, spread ${position.rationale.spread}`,
            });
            recordRegimeState({
              position,
              market: candidate.market,
              token: candidate.token,
              cycle,
              status: 'opened',
              currentPrice: Number(candidate.token.price),
              spread: candidate.spread,
              bidDepth: candidate.bidDepth,
              askDepth: candidate.askDepth,
              imbalance: candidate.imbalance,
              score: candidate.score,
              polyglobe: candidate.polyglobe,
              note: 'Opened paper position',
            });
          }
        }
      }
    }
  } else if (!risk.paused) {
    appendJsonl(decisionsPath, {
      ts: nowIso(),
      type: 'NO_TRADE',
      action: 'HOLD',
      reason: 'no_candidate',
      features_scanned: polyglobeIntel?.breakingMarkets?.length || 0,
      polyglobeMatchedBreakingMarkets: polyglobeIntel?.breakingMarkets?.length || 0,
      note: 'No candidate passed conservative spread/imbalance/risk filters this cycle',
    });
  }

  const openValue = getOpenValue(state);
  const equityUsd = getEquity(state);
  const totalPnlUsd = round2(equityUsd - state.initialUsd);
  state.cycleCount += 1;
  state.lastCycleAt = nowIso();
  state.decisionCount += 1;
  updateRiskState(state);
  appendJsonl(snapshotsPath, {
    ts: state.lastCycleAt,
    cycle: state.cycleCount,
    cashUsd: state.cashUsd,
    reserveUsd: state.risk.reserveUsd,
    openPositions: state.openPositions.length,
    openValueUsd: round2(openValue),
    equityUsd,
    realizedPnlUsd: state.realizedPnlUsd,
    totalPnlUsd,
    paused: state.risk.paused,
    pauseReason: state.risk.pauseReason,
    drawdownUsd: state.risk.drawdownUsd,
    todayLossUsd: state.risk.todayLossUsd,
    consecutiveLosses: state.risk.consecutiveLosses,
  });

  writeAccount(state);
  saveImbalanceWindows();
  return { equityUsd, totalPnlUsd };
}

const SCRIPTS_DIR = resolve(SKILL_ROOT, 'scripts');
const inFlight = new Set();

async function runBatchScript(name, label) {
  if (inFlight.has(name)) return false;
  inFlight.add(name);
  try {
    await execFileAsync('node', [resolve(SCRIPTS_DIR, name)], { timeout: 60000 });
    console.log(`[batch] ${label} done`);
    return true;
  } catch (err) {
    console.error(`[batch] ${label} error:`, err.message);
    return false;
  } finally {
    inFlight.delete(name);
  }
}

// Time-based batch triggers (survives variable cycle delays)
const JUDGE_INTERVAL_MS = 90_000;      // 90 seconds
const BATCH_LABEL_INTERVAL_MS = 180_000; // 3 minutes
const HF_EXPORT_INTERVAL_MS = 300_000;   // 5 minutes
let lastJudgeAt = 0;
let lastBatchLabelAt = 0;
let lastHfExportAt = 0;

async function main() {
  const state = await loadOrInitAccount();
  initPositionMonitor(state, closePosition);
  console.log(`[paper] started with ${state.initialCad} CAD (~${state.initialUsd} USD) | interval=${intervalSec}s followOn=${followOnMode}`);
  console.log(`[paper] exits configured | takeProfitPct=${takeProfitPct} stopLossPct=${stopLossPct} maxHoldHours=${maxHoldHours}`);

  do {
    try {
      const { equityUsd, totalPnlUsd } = await runCycle(state);
      console.log(`[paper] cycle=${state.cycleCount} cash=${state.cashUsd} equity=${equityUsd} pnl=${totalPnlUsd}`);

      // Periodic batch triggers — time-based, fire in background, don't block next cycle
      const now = Date.now();
      if (now - lastJudgeAt >= JUDGE_INTERVAL_MS) {
        lastJudgeAt = now;
        runBatchScript('ambiguity_judge.js', 'ambiguity-judge').catch(() => {});
      }
      if (now - lastBatchLabelAt >= BATCH_LABEL_INTERVAL_MS) {
        lastBatchLabelAt = now;
        runBatchScript('batch_labeler.js', 'batch-labeler').catch(() => {});
      }
      if (now - lastHfExportAt >= HF_EXPORT_INTERVAL_MS) {
        lastHfExportAt = now;
        runBatchScript('export_hf_training_data.js', 'hf-export').catch(() => {});
      }
    } catch (err) {
      appendJsonl(decisionsPath, { ts: nowIso(), type: 'ERROR', error: err.message });
      console.error('[paper] cycle error:', err.message, err.stack?.split('\n').slice(0,3).join(' | '));
    }
    if (once || !running) break;
    if (followOnMode) {
      // Smart delay: if positions are full, wait longer to avoid burning cycles doing nothing
      const positionsFull = state.openPositions.length >= maxPositions;
      await sleep(positionsFull ? 60000 : 3000);
    } else {
      await sleep(Math.max(intervalSec * 1000, 10000));
    }
  } while (running);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

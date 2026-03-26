#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import createBinanceFeed from '../lib/binance_feed.js';
import { computeFairValue } from '../lib/crypto_fair_value.js';
import { initOrderManager, placeMaker } from '../lib/order_manager.js';
import { initPositionMonitor, checkPositions } from '../lib/position_monitor.js';
import { buildReadonlyClient, buildTradingClient, normalizeMarketsResponse, SKILL_ROOT } from '../lib/runtime.js';
import { buildEvidenceBundle } from '../lib/evidence_bundle.js';
import { runTradingAgentsPipeline } from '../lib/tradingagents_bridge.js';
import { createCexMomentumStrategy } from './strategy_cex_momentum.js';
import { discoverCryptoMarkets } from './crypto_market_discovery.js';
import { scanTailBondingCandidates } from './strategy_tail_bonding.js';

const paperDir = resolve(SKILL_ROOT, 'memory', 'paper');
const snapshotPath = resolve(paperDir, 'orchestrator_snapshot.jsonl');
const executionPath = resolve(paperDir, 'orchestrator_execution.jsonl');
mkdirSync(paperDir, { recursive: true });
const useTradingAgents = process.env.TRADING_AGENTS_ENABLED === '1';

function nowIso() {
  return new Date().toISOString();
}

function appendJsonl(path, payload) {
  appendFileSync(path, `${JSON.stringify(payload)}\n`);
}

function clampNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function priceFromToken(tokens = [], outcome = 'Yes') {
  const wanted = String(outcome).toLowerCase();
  const token = tokens.find((entry) => String(entry?.outcome || entry?.name || '').toLowerCase() === wanted);
  return clampNumber(token?.price ?? token?.last_trade_price ?? token?.mid, null);
}

function resolutionTs(market) {
  return [market?.end_date_iso, market?.endDate, market?.resolution_date, market?.resolutionDate, market?.resolve_time, market?.endTime]
    .map((value) => Date.parse(value))
    .find((value) => Number.isFinite(value)) ?? null;
}

function inferUnderlying(market = {}) {
  const text = `${market.question || ''} ${market.slug || ''}`.toLowerCase();
  if (/bitcoin|\bbtc\b/.test(text)) return 'BTC';
  if (/ethereum|\beth\b/.test(text)) return 'ETH';
  return (market.tags || []).find((tag) => /sports|conflict|politics|crypto/i.test(String(tag))) || 'other';
}

async function callTradingAgentsLlm(messages) {
  const scriptPath = process.env.TRADING_AGENTS_LLM_SCRIPT;
  if (!scriptPath) throw new Error('TRADING_AGENTS_LLM_SCRIPT not set');
  const { execFileSync } = await import('child_process');
  const stdout = execFileSync('node', [scriptPath], {
    input: JSON.stringify(messages),
    encoding: 'utf8',
    timeout: Number(process.env.TRADING_AGENTS_LLM_TIMEOUT_MS || 120000),
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  return String(stdout || '').trim();
}

function getBestBid(book) {
  return Math.max(...(book?.bids || []).map((x) => Number(x.price)).filter(Number.isFinite), 0);
}

function getBestAsk(book) {
  const asks = (book?.asks || []).map((x) => Number(x.price)).filter(Number.isFinite);
  return asks.length ? Math.min(...asks) : null;
}

function sumDepth(levels, predicate) {
  return Number(((levels || []).reduce((sum, lvl) => sum + (predicate(Number(lvl.price)) ? Number(lvl.size || 0) : 0), 0)).toFixed(2));
}

async function fetchOrderBookFeatures(client, tokenId) {
  try {
    const book = await client.getOrderBook(tokenId);
    if (!book || typeof book !== 'object' || book.error) return null;
    const bestBid = getBestBid(book);
    const bestAsk = getBestAsk(book);
    if (!bestBid || !bestAsk || bestAsk <= bestBid) return null;
    const spread = Number((bestAsk - bestBid).toFixed(4));
    const bidDepth = sumDepth(book.bids, (p) => p >= bestBid - 0.02);
    const askDepth = sumDepth(book.asks, (p) => p <= bestAsk + 0.02);
    const totalDepth = bidDepth + askDepth;
    const imbalance = totalDepth ? (bidDepth - askDepth) / totalDepth : 0;
    return { bestBid, bestAsk, spread, bidDepth, askDepth, imbalance, book };
  } catch {
    return null;
  }
}

async function runTradingAgentsApproval(intent, marketMeta, readonlyClient, portfolio, config) {
  const market = marketMeta || {};
  const token = (market.tokens || []).find((entry) => String(entry?.token_id || entry?.tokenId) === String(intent.tokenId))
    || { token_id: intent.tokenId, outcome: intent.outcome, price: intent.price };
  const orderbook = await fetchOrderBookFeatures(readonlyClient, intent.tokenId);
  const candidate = {
    market: {
      ...market,
      condition_id: market.condition_id || market.marketId || intent.marketId,
      question: market.question || intent.question || intent.reason,
      category: inferCategory(market.question || intent.question || intent.reason, market.tags || [intent.category].filter(Boolean)),
    },
    token: {
      ...token,
      token_id: token.token_id || token.tokenId || intent.tokenId,
      outcome: token.outcome || intent.outcome,
      price: Number(token.price ?? intent.price),
    },
    spread: orderbook?.spread ?? 0.02,
    bidDepth: orderbook?.bidDepth ?? 0,
    askDepth: orderbook?.askDepth ?? 0,
    imbalance: orderbook?.imbalance ?? 0,
    bestBid: orderbook?.bestBid ?? null,
    bestAsk: orderbook?.bestAsk ?? Number(intent.price),
    category: intent.category || inferCategory(market.question || intent.question || intent.reason, market.tags),
  };

  const evidenceBundle = buildEvidenceBundle(candidate, {
    risk: {
      equityUsd: riskEnginePlaceholder(config, portfolio),
      paused: false,
      drawdownUsd: 0,
      todayLossUsd: 0,
      consecutiveLosses: 0,
    },
    account: {
      ...portfolio,
      cashUsd: config.capital,
      equityUsd: riskEnginePlaceholder(config, portfolio),
      maxPositions: config.maxPositions,
      categoryExposure: portfolio.openPositions.reduce((acc, position) => {
        acc[position.category || 'general'] = (acc[position.category || 'general'] || 0) + 1;
        return acc;
      }, {}),
    },
    maxPositions: config.maxPositions,
  });

  return runTradingAgentsPipeline(evidenceBundle, { llmCallFn: callTradingAgentsLlm });
}

function riskEnginePlaceholder(config, portfolio) {
  const realized = portfolio.executions.reduce((sum, execution) => sum + clampNumber(execution.realizedPnlUsd, 0), 0);
  return clampNumber(config.capital + realized, config.capital);
}

function inferCategory(question = '', tags = []) {
  const haystack = `${question} ${(tags || []).join(' ')}`.toLowerCase();
  if (/sports|nba|nfl|mlb|team|match|game/.test(haystack)) return 'sports';
  if (/war|conflict|attack|ceasefire|military/.test(haystack)) return 'conflict';
  if (/bitcoin|btc|ethereum|eth|crypto/.test(haystack)) return 'crypto';
  if (/election|president|senate|house|mayor/.test(haystack)) return 'politics';
  return 'general';
}

function buildRiskEngine(config, portfolio) {
  const state = {
    equity: config.capital,
    peakEquity: config.capital,
    drawdown: 0,
    todayPnl: 0,
    consecutiveLosses: {},
    pausedStrategies: new Set(),
    pauseAll: false,
  };

  function recompute() {
    const openExposure = portfolio.openPositions.reduce((sum, position) => sum + clampNumber(position.costUsd, 0), 0);
    const realizedPnl = portfolio.executions.reduce((sum, execution) => sum + clampNumber(execution.realizedPnlUsd, 0), 0);
    state.equity = clampNumber(config.capital + realizedPnl, config.capital) + openExposure * 0;
    state.peakEquity = Math.max(state.peakEquity, state.equity);
    state.drawdown = state.peakEquity > 0 ? (state.peakEquity - state.equity) / state.peakEquity : 0;
    state.todayPnl = realizedPnl;
    state.pauseAll = state.drawdown > config.maxDrawdownPct || state.todayPnl < (-config.maxDailyLossPct * state.equity);
  }

  function recordExit(exitEvent) {
    if (!exitEvent?.strategy) return;
    const pnl = clampNumber(exitEvent.pnl ?? exitEvent.realizedPnlUsd, 0);
    if (pnl < 0) state.consecutiveLosses[exitEvent.strategy] = (state.consecutiveLosses[exitEvent.strategy] || 0) + 1;
    else state.consecutiveLosses[exitEvent.strategy] = 0;
  }

  function strategyPaused(name) {
    return state.pauseAll || (state.consecutiveLosses[name] || 0) > 3 || state.pausedStrategies.has(name);
  }

  return { state, recompute, recordExit, strategyPaused };
}

async function buildMakerRebateIntents({ client, budgetUsd, discoveredMarkets, feed }) {
  const intents = [];
  const activeMarkets = discoveredMarkets.filter((market) => market.active && !market.expired).slice(0, 10);
  for (const market of activeMarkets) {
    const asset = market.underlyingAsset;
    if (!asset) continue;
    const spotPrice = feed.getPrice(asset);
    if (!Number.isFinite(spotPrice) || !Number.isFinite(market.currentPrice?.yes)) continue;
    const timeRemainingSec = Math.max(1, Math.floor((Date.parse(market.resolutionTime) - Date.now()) / 1000));
    const windowOpenPrice = spotPrice - ((feed.getReturn(asset, 15) || 0) / 10000) * spotPrice;
    const fair = computeFairValue({
      currentSpotPrice: spotPrice,
      windowOpenPrice,
      timeRemainingSec,
      realizedVol: feed.getVolatility(asset) || 0.0005,
      pmYesPrice: market.currentPrice?.yes,
      pmNoPrice: market.currentPrice?.no,
      shortReturnBps: feed.getReturn(asset, 5) || 0,
    });
    const edgeYes = clampNumber(fair.edgeYesBps, 0);
    if (edgeYes < 20) continue;
    intents.push({
      strategy: 'maker_rebate',
      action: 'BUY',
      marketId: market.marketId,
      tokenId: market.tokenIds.yes,
      outcome: 'Yes',
      price: Number(Math.max(0.01, Math.min(0.99, market.currentPrice.yes - 0.01)).toFixed(4)),
      sizeUsd: Number(Math.max(5, budgetUsd).toFixed(2)),
      urgency: edgeYes > 60 ? 'medium' : 'low',
      expectedEdgeBps: Math.round(edgeYes),
      reason: `Maker quote around fair value for ${asset}; edge ${Math.round(edgeYes)}bps`,
      category: 'crypto',
      underlying: asset,
    });
    if (intents.length >= 2) break;
  }
  return intents;
}

function buildPortfolioIntentView(intent, marketMeta = {}) {
  return {
    ...intent,
    category: intent.category || inferCategory(marketMeta.question, marketMeta.tags),
    underlying: intent.underlying || inferUnderlying(marketMeta),
  };
}

function approveIntents(intents, portfolio, config, riskEngine) {
  const approved = [];
  const exposuresByCategory = Object.create(null);
  const exposuresByUnderlying = Object.create(null);

  for (const position of portfolio.openPositions) {
    exposuresByCategory[position.category] = (exposuresByCategory[position.category] || 0) + 1;
    exposuresByUnderlying[position.underlying] = (exposuresByUnderlying[position.underlying] || 0) + 1;
  }

  for (const intent of intents) {
    if (riskEngine.strategyPaused(intent.strategy)) continue;
    if (portfolio.openPositions.length + approved.length >= config.maxPositions) continue;

    const categoryLimit = ['sports', 'conflict'].includes(intent.category) ? 1 : 2;
    const categoryCount = exposuresByCategory[intent.category] || 0;
    const underlyingCount = exposuresByUnderlying[intent.underlying] || 0;
    if (categoryCount >= categoryLimit) continue;
    if (['BTC', 'ETH'].includes(String(intent.underlying).toUpperCase()) && underlyingCount >= 3) continue;

    exposuresByCategory[intent.category] = categoryCount + 1;
    exposuresByUnderlying[intent.underlying] = underlyingCount + 1;
    approved.push(intent);
  }

  return approved;
}

async function executeIntent(intent, portfolio, config, tradingClient) {
  const execution = {
    ts: nowIso(),
    ...intent,
    mode: config.paper ? 'paper' : 'live',
    status: 'accepted',
  };

  if (config.paper) {
    const shares = intent.price > 0 ? intent.sizeUsd / intent.price : 0;
    portfolio.openPositions.push({
      strategy: intent.strategy,
      marketId: intent.marketId,
      tokenId: intent.tokenId,
      question: intent.question,
      outcome: intent.outcome,
      category: intent.category,
      underlying: intent.underlying,
      entryPrice: intent.price,
      shares,
      costUsd: intent.sizeUsd,
      openedAt: nowIso(),
      highWaterPrice: intent.price,
      status: 'open',
    });
    appendJsonl(executionPath, execution);
    return execution;
  }

  const sizeContracts = intent.price > 0 ? intent.sizeUsd / intent.price : 0;
  const result = await placeMaker({ tokenId: intent.tokenId, side: intent.action, price: intent.price, size: sizeContracts, tickSize: '0.01', negRisk: false });
  execution.liveResult = result;
  execution.status = result ? 'submitted' : 'failed';
  appendJsonl(executionPath, execution);
  return execution;
}

async function closePosition(portfolioState, position, exitPrice, reason) {
  const index = portfolioState.openPositions.findIndex((entry) => entry.tokenId === position.tokenId && entry.openedAt === position.openedAt);
  if (index === -1) return;
  const closed = portfolioState.openPositions.splice(index, 1)[0];
  const realizedPnlUsd = Number((((closed.shares || 0) * exitPrice) - (closed.costUsd || 0)).toFixed(2));
  const event = {
    ts: nowIso(),
    strategy: closed.strategy,
    marketId: closed.marketId,
    tokenId: closed.tokenId,
    reason,
    exitPrice,
    realizedPnlUsd,
    pnl: realizedPnlUsd,
  };
  portfolioState.executions.push(event);
  appendJsonl(executionPath, event);
}

async function main() {
  const args = minimist(process.argv.slice(2), {
    boolean: ['paper'],
    default: {
      paper: true,
      interval: 10,
      capital: 1000,
      'total-capital-usd': 1000,
      'allocation-momentum': 50,
      'allocation-maker': 30,
      'allocation-tail': 20,
      'max-positions': 10,
      'max-drawdown-pct': 0.2,
      'max-daily-loss-pct': 0.05,
    },
  });

  const config = {
    paper: args.paper !== false,
    intervalSec: Number(args.interval || 10),
    capital: Number(args.capital || args['total-capital-usd'] || 1000),
    allocations: {
      cex_momentum: Number(args['allocation-momentum'] || 50) / 100,
      maker_rebate: Number(args['allocation-maker'] || 30) / 100,
      tail_bonding: Number(args['allocation-tail'] || 20) / 100,
    },
    maxPositions: Number(args['max-positions'] || 10),
    maxDrawdownPct: Number(args['max-drawdown-pct'] || 0.2),
    maxDailyLossPct: Number(args['max-daily-loss-pct'] || 0.05),
  };

  const readonlyClient = buildReadonlyClient();
  const tradingClient = config.paper ? null : buildTradingClient();
  if (tradingClient) initOrderManager(tradingClient);

  const portfolio = {
    strategies: {
      cex_momentum: { allocatedUsd: config.capital * config.allocations.cex_momentum },
      maker_rebate: { allocatedUsd: config.capital * config.allocations.maker_rebate },
      tail_bonding: { allocatedUsd: config.capital * config.allocations.tail_bonding },
    },
    bankroll: { total: config.capital, allocated: config.capital, reserved: 0 },
    riskLimits: {
      maxPositions: config.maxPositions,
      maxDrawdownPct: config.maxDrawdownPct,
      maxDailyLossPct: config.maxDailyLossPct,
    },
    openPositions: [],
    executions: [],
  };

  const riskEngine = buildRiskEngine(config, portfolio);
  const sharedFeed = createBinanceFeed({ assets: ['BTC', 'ETH'] });
  const cexStrategy = createCexMomentumStrategy({ paper: config.paper, feed: sharedFeed, assets: ['BTC', 'ETH'] });
  let discoveredMarkets = [];
  let tailCache = [];
  let tailCacheAt = 0;

  initPositionMonitor({ openPositions: portfolio.openPositions, strategy: {} }, async (_state, position, price, reason) => {
    await closePosition(portfolio, position, price, reason);
  });

  async function refreshDiscoveredMarkets() {
    discoveredMarkets = await discoverCryptoMarkets();
    return discoveredMarkets;
  }

  async function collectTailIntents(budgetUsd) {
    const now = Date.now();
    if (!tailCache.length || (now - tailCacheAt) >= 300_000) {
      tailCache = await scanTailBondingCandidates({ client: readonlyClient, limit: 10, windowDays: 7 });
      tailCacheAt = now;
    }

    return tailCache.slice(0, 2).map((candidate) => ({
      strategy: 'tail_bonding',
      action: 'BUY',
      marketId: candidate.marketId,
      tokenId: candidate.tokenId,
      outcome: candidate.outcome,
      price: candidate.price,
      sizeUsd: Number(Math.max(5, budgetUsd).toFixed(2)),
      urgency: candidate.daysToResolution < 1 ? 'medium' : 'low',
      expectedEdgeBps: Math.round(candidate.annualizedCarry * 10000),
      reason: `Tail carry ${candidate.carry.toFixed(4)} into resolution in ${candidate.daysToResolution.toFixed(2)}d`,
      question: candidate.question,
      category: inferCategory(candidate.question),
      underlying: inferUnderlying({ question: candidate.question }),
    }));
  }

  async function cycle() {
    riskEngine.recompute();
    await refreshDiscoveredMarkets();

    const intents = [];
    const disconnectAgeMs = Date.now() - Math.max(sharedFeed.snapshot().BTC?.updatedAt || 0, sharedFeed.snapshot().ETH?.updatedAt || 0);
    if (!riskEngine.state.pauseAll && disconnectAgeMs <= 60_000) {
      const momentumBudget = Math.max(10, portfolio.strategies.cex_momentum.allocatedUsd * 0.05);
      const cexIntents = await cexStrategy.tick({ budgetUsd: momentumBudget });
      intents.push(...cexIntents.map((intent) => buildPortfolioIntentView(intent, { question: intent.diagnostics?.question, slug: intent.diagnostics?.slug, tags: ['crypto'] })));
    }

    if (!riskEngine.strategyPaused('maker_rebate')) {
      const makerBudget = Math.max(10, portfolio.strategies.maker_rebate.allocatedUsd * 0.05);
      const makerIntents = await buildMakerRebateIntents({ client: readonlyClient, budgetUsd: makerBudget, discoveredMarkets, feed: sharedFeed });
      intents.push(...makerIntents.map((intent) => buildPortfolioIntentView(intent, { question: intent.reason, tags: ['crypto'] })));
    }

    if (!riskEngine.strategyPaused('tail_bonding')) {
      const tailBudget = Math.max(10, portfolio.strategies.tail_bonding.allocatedUsd * 0.1);
      const tailIntents = await collectTailIntents(tailBudget);
      intents.push(...tailIntents);
    }

    const approved = approveIntents(intents, portfolio, config, riskEngine);
    const marketUniverse = normalizeMarketsResponse(await readonlyClient.getSamplingMarkets());
    const marketMap = new Map(marketUniverse.map((market) => [String(market.condition_id || market.marketId || market.id), market]));
    const taApproved = [];

    for (const intent of approved) {
      let gatedIntent = intent;
      if (!useTradingAgents) {
        taApproved.push(gatedIntent);
        continue;
      }

      try {
        const marketMeta = marketMap.get(String(intent.marketId)) || discoveredMarkets.find((market) => String(market.marketId) === String(intent.marketId)) || null;
        const taDecision = await runTradingAgentsApproval(intent, marketMeta, readonlyClient, portfolio, config);
        appendJsonl(executionPath, {
          ts: nowIso(),
          type: 'TRADING_AGENTS_GATE',
          marketId: intent.marketId,
          tokenId: intent.tokenId,
          question: intent.question || marketMeta?.question || null,
          strategy: intent.strategy,
          decision: taDecision.decision,
          finalProposal: taDecision.finalProposal || null,
          runId: taDecision.runId || null,
        });

        if (['APPROVE', 'REDUCE'].includes(String(taDecision.decision || '').toUpperCase())) {
          if (String(taDecision.decision).toUpperCase() === 'REDUCE') {
            const reduced = clampNumber(taDecision.finalProposal?.final_size_usd, intent.sizeUsd);
            gatedIntent = { ...intent, sizeUsd: Math.max(1, Math.min(intent.sizeUsd, reduced || intent.sizeUsd)) };
          }
          taApproved.push(gatedIntent);
        }
      } catch (error) {
        appendJsonl(executionPath, {
          ts: nowIso(),
          type: 'TRADING_AGENTS_GATE_ERROR',
          marketId: intent.marketId,
          tokenId: intent.tokenId,
          strategy: intent.strategy,
          error: error.message,
        });
      }
    }

    const executed = [];
    for (const intent of taApproved) {
      executed.push(await executeIntent(intent, portfolio, config, tradingClient));
    }

    const executionCountBefore = portfolio.executions.length;
    await checkPositions({ openPositions: portfolio.openPositions, strategy: {} }, { client: readonlyClient, decisionsPath: executionPath });
    for (const execution of portfolio.executions.slice(executionCountBefore)) {
      riskEngine.recordExit(execution);
    }
    riskEngine.recompute();

    const snapshot = {
      ts: nowIso(),
      paper: config.paper,
      bankroll: portfolio.bankroll,
      risk: {
        equity: riskEngine.state.equity,
        peakEquity: riskEngine.state.peakEquity,
        drawdown: riskEngine.state.drawdown,
        todayPnl: riskEngine.state.todayPnl,
        consecutiveLosses: riskEngine.state.consecutiveLosses,
        pauseAll: riskEngine.state.pauseAll,
      },
      positionsOpen: portfolio.openPositions.length,
      intentCount: intents.length,
      approvedCount: approved.length,
      taApprovedCount: taApproved.length,
      executedCount: executed.length,
      discoveredMarkets: discoveredMarkets.length,
      tailCandidates: tailCache.length,
      feedConnected: sharedFeed.isConnected(),
    };
    appendJsonl(snapshotPath, snapshot);
    console.log(`[orchestrator] ${snapshot.ts} intents=${snapshot.intentCount} approved=${snapshot.approvedCount} open=${snapshot.positionsOpen} dd=${(snapshot.risk.drawdown * 100).toFixed(2)}%`);
  }

  process.on('SIGINT', () => {
    cexStrategy.shutdown();
    sharedFeed.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cexStrategy.shutdown();
    sharedFeed.close();
    process.exit(0);
  });

  console.log(`[orchestrator] started | paper=${config.paper} capital=${config.capital} interval=${config.intervalSec}s`);
  await cycle();
  setInterval(() => {
    cycle().catch((error) => {
      console.error('[orchestrator] cycle failed:', error.message);
    });
  }, config.intervalSec * 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

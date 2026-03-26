#!/usr/bin/env node

/**
 * CEX momentum strategy MVP for Polymarket short-duration crypto markets.
 * Standalone CLI + reusable module for main_orchestrator.js.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import createBinanceFeed from '../lib/binance_feed.js';
import { computeFairValue } from '../lib/crypto_fair_value.js';
import { SKILL_ROOT } from '../lib/runtime.js';
import { discoverCryptoMarkets } from './crypto_market_discovery.js';

const DEFAULTS = {
  paper: true,
  minEdgeBps: Number(process.env.CEX_MIN_EDGE_BPS || 50),
  maxHoldSeconds: Number(process.env.CEX_MAX_HOLD_SECONDS || 900),
  assets: String(process.env.CEX_ASSETS || 'BTC,ETH').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean),
};

const paperDir = resolve(SKILL_ROOT, 'memory', 'paper');
const logPath = resolve(paperDir, 'cex_momentum_log.jsonl');
const statePath = resolve(paperDir, 'cex_momentum_state.json');
mkdirSync(paperDir, { recursive: true });

function loadState() {
  if (!existsSync(statePath)) {
    return { windowOpenPrices: {}, positions: [], opportunities: 0, lastDiscoveryAt: null };
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return { windowOpenPrices: {}, positions: [], opportunities: 0, lastDiscoveryAt: null };
  }
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function appendLog(entry) {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function inferDirection(question) {
  const lower = String(question || '').toLowerCase();
  if (/(up|higher|above)/.test(lower)) return 'YES';
  if (/(down|lower|below)/.test(lower)) return 'NO';
  return 'YES';
}

function pickActiveMarket(asset, markets, maxHoldSeconds) {
  const now = Date.now();
  return markets
    .filter((market) => market.active && !market.expired)
    .filter((market) => market.underlyingAsset === asset)
    .filter((market) => Number.isFinite(market.windowSeconds) && market.windowSeconds <= maxHoldSeconds)
    .map((market) => ({ ...market, timeRemainingSec: Math.max(0, Math.floor((Date.parse(market.resolutionTime) - now) / 1000)) }))
    .filter((market) => market.timeRemainingSec > 0)
    .sort((a, b) => a.timeRemainingSec - b.timeRemainingSec)[0] ?? null;
}

function getWindowKey(market) {
  return `${market.underlyingAsset}:${market.slug || market.marketId}`;
}

function windowOpenPriceFor(state, asset, market, spotPrice) {
  const key = getWindowKey(market);
  if (!state.windowOpenPrices[key]) {
    state.windowOpenPrices[key] = {
      asset,
      marketId: market.marketId,
      slug: market.slug,
      price: spotPrice,
      capturedAt: nowIso(),
    };
    saveState(state);
  }
  return state.windowOpenPrices[key].price;
}

export function createCexMomentumStrategy(options = {}) {
  const config = {
    ...DEFAULTS,
    ...options,
    assets: Array.isArray(options.assets) ? options.assets.map((v) => String(v).trim().toUpperCase()).filter(Boolean) : DEFAULTS.assets,
  };

  const state = loadState();
  const abortController = new AbortController();
  const feed = options.feed || createBinanceFeed({ assets: config.assets, signal: abortController.signal });
  let discoveredMarkets = [];
  let lastDiscoveryAtMs = 0;

  async function refreshDiscovery(force = false) {
    const now = Date.now();
    if (!force && (now - lastDiscoveryAtMs) < 60_000 && discoveredMarkets.length) return discoveredMarkets;
    discoveredMarkets = await discoverCryptoMarkets();
    lastDiscoveryAtMs = now;
    state.lastDiscoveryAt = nowIso();
    saveState(state);
    return discoveredMarkets;
  }

  function evaluateAsset(asset) {
    const spotPrice = feed.getPrice(asset);
    if (!Number.isFinite(spotPrice)) return null;

    const market = pickActiveMarket(asset, discoveredMarkets, config.maxHoldSeconds);
    if (!market) return null;

    const pmYesPrice = Number(market.currentPrice?.yes);
    const pmNoPrice = Number(market.currentPrice?.no);
    if (!Number.isFinite(pmYesPrice) && !Number.isFinite(pmNoPrice)) return null;

    const windowOpenPrice = windowOpenPriceFor(state, asset, market, spotPrice);
    const shortReturnBps = feed.getReturn(asset, 5) ?? 0;
    const realizedVol = feed.getVolatility(asset) ?? 0.0005;
    const fair = computeFairValue({
      currentSpotPrice: spotPrice,
      windowOpenPrice,
      timeRemainingSec: market.timeRemainingSec,
      realizedVol,
      pmYesPrice,
      pmNoPrice,
      shortReturnBps,
    });

    const direction = inferDirection(market.question);
    const outcome = direction === 'YES' ? 'Yes' : 'No';
    const actionableEdge = direction === 'YES' ? fair.edgeYesBps : fair.edgeNoBps;
    const targetPrice = direction === 'YES' ? pmYesPrice : pmNoPrice;
    if (!Number.isFinite(actionableEdge) || actionableEdge < config.minEdgeBps || !Number.isFinite(targetPrice)) return null;

    state.opportunities += 1;
    saveState(state);

    return {
      strategy: 'cex_momentum',
      action: 'BUY',
      marketId: market.marketId,
      tokenId: direction === 'YES' ? market.tokenIds.yes : market.tokenIds.no,
      outcome,
      price: Number(targetPrice.toFixed(4)),
      sizeUsd: 0,
      urgency: actionableEdge >= (config.minEdgeBps * 2) ? 'high' : 'medium',
      expectedEdgeBps: Math.round(actionableEdge),
      reason: `${asset} ${shortReturnBps >= 0 ? '+' : ''}${Math.round(shortReturnBps)} bps in 5s; PM lagging (${fair.model})`,
      diagnostics: {
        asset,
        slug: market.slug,
        question: market.question,
        fairYes: fair.fairYes,
        fairNo: fair.fairNo,
        timeRemainingSec: market.timeRemainingSec,
        windowOpenPrice,
        spotPrice,
        confidence: fair.confidence,
      },
    };
  }

  async function tick({ budgetUsd = 25 } = {}) {
    await refreshDiscovery();
    const intents = [];
    for (const asset of config.assets) {
      const intent = evaluateAsset(asset);
      if (!intent) continue;
      intent.sizeUsd = Number(Math.max(5, budgetUsd).toFixed(2));
      intents.push(intent);
      appendLog({ ts: nowIso(), ...intent, mode: config.paper ? 'paper' : 'live-disabled-mvp' });
    }
    return intents;
  }

  return {
    name: 'cex_momentum',
    config,
    state,
    feed,
    refreshDiscovery,
    tick,
    shutdown() {
      abortController.abort();
      if (typeof feed.close === 'function') feed.close();
      saveState(state);
    },
  };
}

async function main() {
  const args = minimist(process.argv.slice(2), {
    boolean: ['paper'],
    string: ['assets'],
    default: {
      paper: true,
      'min-edge-bps': DEFAULTS.minEdgeBps,
      'max-hold-seconds': DEFAULTS.maxHoldSeconds,
      assets: DEFAULTS.assets.join(','),
    },
  });

  const strategy = createCexMomentumStrategy({
    paper: args.paper !== false,
    minEdgeBps: Number(args['min-edge-bps'] || DEFAULTS.minEdgeBps),
    maxHoldSeconds: Number(args['max-hold-seconds'] || DEFAULTS.maxHoldSeconds),
    assets: String(args.assets || DEFAULTS.assets.join(',')).split(',').map((v) => v.trim().toUpperCase()).filter(Boolean),
  });

  process.on('SIGINT', () => {
    strategy.shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    strategy.shutdown();
    process.exit(0);
  });

  await strategy.refreshDiscovery(true);
  console.log(`[cex-momentum] started | paper=${strategy.config.paper} minEdgeBps=${strategy.config.minEdgeBps} assets=${strategy.config.assets.join(',')}`);

  setInterval(async () => {
    try {
      const intents = await strategy.tick({ budgetUsd: 25 });
      for (const intent of intents) {
        console.log(`[CEX-EDGE] ${intent.diagnostics.asset} | px=${intent.price.toFixed(4)} edge=${intent.expectedEdgeBps}bps | ${intent.reason}`);
      }
    } catch (error) {
      console.error('[cex-momentum] tick failed:', error.message);
    }
  }, 1_000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import { buildReadonlyClient, normalizeMarketsResponse, SKILL_ROOT } from '../lib/runtime.js';

const LOG_PATH = resolve(SKILL_ROOT, 'memory', 'paper', 'tail_bonding_candidates.jsonl');
mkdirSync(resolve(SKILL_ROOT, 'memory', 'paper'), { recursive: true });

function numberOr(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseDate(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function resolutionTimestamp(market) {
  return [
    market?.end_date_iso,
    market?.endDate,
    market?.resolution_date,
    market?.resolutionDate,
    market?.resolve_time,
    market?.endTime,
  ].map(parseDate).find((ts) => Number.isFinite(ts)) ?? null;
}

function normalizeTokens(tokens = []) {
  return tokens.map((token) => ({
    tokenId: token?.token_id ?? token?.id ?? null,
    outcome: String(token?.outcome || token?.name || '').trim() || null,
    price: numberOr(token?.price ?? token?.last_trade_price ?? token?.mid),
  })).filter((token) => token.tokenId && token.outcome && Number.isFinite(token.price));
}

function bestLevels(book, side) {
  const levels = Array.isArray(book?.[side]) ? book[side] : [];
  return levels.map((level) => ({ price: numberOr(level?.price), size: numberOr(level?.size, 0) })).filter((l) => Number.isFinite(l.price));
}

async function getSpread(client, tokenId, fallbackPrice = null) {
  try {
    const book = await client.getOrderbook(tokenId);
    const bids = bestLevels(book, 'bids');
    const asks = bestLevels(book, 'asks');
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestAsk >= bestBid) {
      return { spread: bestAsk - bestBid, bestBid, bestAsk };
    }
  } catch {
    // ignore and fall back
  }
  return { spread: Number.isFinite(fallbackPrice) ? 0.02 : null, bestBid: null, bestAsk: null };
}

function liquidityOf(market) {
  return numberOr(market?.liquidity, numberOr(market?.liquidity_num, 0)) ?? 0;
}

function analyzeAmbiguity(question) {
  const text = String(question || '').trim();
  const lower = text.toLowerCase();
  let score = 1;

  const subjective = /(will\s+.+\b(say|announce|support|perform)\b|\bmeaningfully\b|\baccording to\b)/i;
  const conditional = /\b(if|unless|provided that|as long as|subject to)\b/i;
  const objective = /(will\s+(price|btc|eth|bitcoin|ethereum)\s+be\s+(above|below)|will\s+score\s+be|will\s+team\s+win|will\s+candidate\s+win|will\s+close\s+above)/i;
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (subjective.test(lower)) score -= 0.45;
  if (conditional.test(lower)) score -= 0.3;
  if (objective.test(lower)) score += 0.2;
  if (wordCount > 50) score -= Math.min(0.25, ((wordCount - 50) / 100));
  if (/[;:()]/.test(text)) score -= 0.05;

  return Math.max(0, Math.min(1.5, Number(score.toFixed(3))));
}

function scoreCandidate({ price, daysToResolution, spread, ambiguityScore }) {
  const carry = 1 - price;
  const annualizedCarry = daysToResolution > 0 ? carry / (daysToResolution / 365) : 0;
  const spreadPenalty = (spread ?? 0.02) * 3;
  const timeBonus = 1 / Math.max(daysToResolution, 0.125);
  return {
    carry,
    annualizedCarry,
    score: (annualizedCarry * 0.55) + (carry * 3.5) + timeBonus - spreadPenalty + ((ambiguityScore - 1) * 2),
  };
}

export async function scanTailBondingCandidates(options = {}) {
  const config = {
    windowDays: Number(options.windowDays || 7),
    minPrice: Number(options.minPrice || 0.95),
    maxPrice: Number(options.maxPrice || 0.99),
    maxSpread: Number(options.maxSpread || 0.03),
    minLiquidity: Number(options.minLiquidity || 1000),
    limit: Number(options.limit || 50),
  };

  const client = options.client || buildReadonlyClient();
  const now = Date.now();
  let markets = [];

  try {
    markets = normalizeMarketsResponse(await client.getSamplingMarkets());
  } catch {
    markets = normalizeMarketsResponse(await client.getMarkets());
  }

  const candidates = [];
  for (const market of markets) {
    if (!market?.active || market?.closed) continue;
    const resolutionTs = resolutionTimestamp(market);
    if (!Number.isFinite(resolutionTs) || resolutionTs <= now) continue;

    const daysToResolution = (resolutionTs - now) / 86_400_000;
    if (daysToResolution > config.windowDays) continue;
    if (liquidityOf(market) < config.minLiquidity) continue;

    const question = String(market?.question || market?.title || '').trim();
    const ambiguityScore = analyzeAmbiguity(question);
    const tokens = normalizeTokens(market?.tokens || []);
    const eligibleTokens = tokens.filter((token) => token.price >= config.minPrice && token.price <= config.maxPrice);
    if (!eligibleTokens.length) continue;

    for (const token of eligibleTokens) {
      const spreadInfo = await getSpread(client, token.tokenId, token.price);
      if (!Number.isFinite(spreadInfo.spread) || spreadInfo.spread >= config.maxSpread) continue;

      const metrics = scoreCandidate({
        price: token.price,
        daysToResolution,
        spread: spreadInfo.spread,
        ambiguityScore,
      });

      const candidate = {
        ts: new Date().toISOString(),
        marketId: market?.condition_id ?? market?.id ?? null,
        question,
        tokenId: token.tokenId,
        outcome: token.outcome,
        price: Number(token.price.toFixed(4)),
        carry: Number(metrics.carry.toFixed(4)),
        annualizedCarry: Number(metrics.annualizedCarry.toFixed(4)),
        daysToResolution: Number(daysToResolution.toFixed(4)),
        spreadBps: Math.round((spreadInfo.spread ?? 0) * 10000),
        ambiguityScore,
        liquidity: liquidityOf(market),
        resolutionDate: new Date(resolutionTs).toISOString(),
        internalScore: metrics.score,
      };
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => b.internalScore - a.internalScore || b.annualizedCarry - a.annualizedCarry || a.daysToResolution - b.daysToResolution);
  const ranked = candidates.slice(0, config.limit).map((candidate, index) => ({
    ts: candidate.ts,
    marketId: candidate.marketId,
    question: candidate.question,
    tokenId: candidate.tokenId,
    outcome: candidate.outcome,
    price: candidate.price,
    carry: candidate.carry,
    annualizedCarry: candidate.annualizedCarry,
    daysToResolution: candidate.daysToResolution,
    spreadBps: candidate.spreadBps,
    ambiguityScore: candidate.ambiguityScore,
    rank: index + 1,
  }));

  for (const candidate of ranked) {
    appendFileSync(LOG_PATH, `${JSON.stringify(candidate)}\n`);
  }

  return ranked;
}

async function main() {
  const args = minimist(process.argv.slice(2), {
    default: {
      'window-days': 7,
      'min-price': 0.95,
      'max-price': 0.99,
      'max-spread': 0.03,
      'min-liquidity': 1000,
      limit: 50,
    },
  });

  const candidates = await scanTailBondingCandidates({
    windowDays: Number(args['window-days']),
    minPrice: Number(args['min-price']),
    maxPrice: Number(args['max-price']),
    maxSpread: Number(args['max-spread']),
    minLiquidity: Number(args['min-liquidity']),
    limit: Number(args.limit),
  });

  process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

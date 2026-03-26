#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import { SKILL_ROOT } from '../lib/runtime.js';

const args = minimist(process.argv.slice(2));
const tradesPath = resolve(SKILL_ROOT, 'memory', 'paper', 'trades.jsonl');
const snapshotsPath = resolve(SKILL_ROOT, 'memory', 'paper', 'snapshots.jsonl');
const bootstrapRuns = Math.max(100, parseInt(args.bootstrap || 10000, 10) || 10000);
const burnIn = Math.max(0, parseInt(args['burn-in'] || 3, 10) || 3);
const startingCapital = Number(args.capital || 14.57);

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

function maxDrawdown(equity) {
  let peak = equity[0] || 0;
  let maxDd = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    maxDd = Math.max(maxDd, peak - value);
  }
  return maxDd;
}

function bootstrapSample(values) {
  return Array.from({ length: values.length }, () => values[Math.floor(Math.random() * values.length)]);
}

const trades = readJsonl(tradesPath).filter((t) => t.type === 'EXIT');
const snapshots = readJsonl(snapshotsPath);
const filteredTrades = trades.slice(burnIn);

if (!filteredTrades.length) {
  console.log(JSON.stringify({
    ok: false,
    message: `No closed trades after burn-in=${burnIn}. Need exits before edge testing means anything.`,
    totalClosedTrades: trades.length,
  }, null, 2));
  process.exit(0);
}

const pnlSeries = filteredTrades.map((t) => Number(t.pnlUsd || 0));
const returnSeries = filteredTrades.map((t) => Number(t.costUsd ? t.pnlUsd / t.costUsd : 0));
const winSeries = filteredTrades.map((t) => (Number(t.pnlUsd || 0) > 0 ? 1 : 0));

const baseWinRate = mean(winSeries);
const baseEv = mean(pnlSeries);
const baseSharpe = stddev(returnSeries) === 0 ? 0 : mean(returnSeries) / stddev(returnSeries);
const snapshotEquity = snapshots.map((s) => Number(s.equityUsd)).filter(Number.isFinite);
const baseDrawdown = snapshotEquity.length ? maxDrawdown(snapshotEquity) : null;

const winBoot = [];
const evBoot = [];
const sharpeBoot = [];

for (let i = 0; i < bootstrapRuns; i++) {
  const pnlSample = bootstrapSample(pnlSeries);
  const retSample = bootstrapSample(returnSeries);
  const winSample = bootstrapSample(winSeries);

  winBoot.push(mean(winSample));
  evBoot.push(mean(pnlSample));
  const s = stddev(retSample);
  sharpeBoot.push(s === 0 ? 0 : mean(retSample) / s);
}

winBoot.sort((a, b) => a - b);
evBoot.sort((a, b) => a - b);
sharpeBoot.sort((a, b) => a - b);

const report = {
  ok: true,
  sample: {
    closedTrades: trades.length,
    analyzedTrades: filteredTrades.length,
    burnInDiscarded: burnIn,
    bootstrapRuns,
  },
  estimates: {
    winRate: baseWinRate,
    evPerTradeUsd: baseEv,
    sharpe: baseSharpe,
    maxDrawdownUsd: baseDrawdown,
    netPnlUsd: pnlSeries.reduce((sum, x) => sum + x, 0),
    endingCapitalUsd: startingCapital + pnlSeries.reduce((sum, x) => sum + x, 0),
  },
  ci95: {
    winRate: [quantile(winBoot, 0.025), quantile(winBoot, 0.975)],
    evPerTradeUsd: [quantile(evBoot, 0.025), quantile(evBoot, 0.975)],
    sharpe: [quantile(sharpeBoot, 0.025), quantile(sharpeBoot, 0.975)],
  },
  decisions: {
    winRateEdge: !(quantile(winBoot, 0.025) <= 0.5 && 0.5 <= quantile(winBoot, 0.975)),
    evPositive: quantile(evBoot, 0.025) > 0,
    sharpePositive: quantile(sharpeBoot, 0.025) > 0,
  },
  note: 'Do not trust edge until enough closed trades accumulate. Bootstrap CI on tiny samples is still noisy.',
};

console.log(JSON.stringify(report, null, 2));

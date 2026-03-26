#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import { SKILL_ROOT } from '../lib/runtime.js';

const args = minimist(process.argv.slice(2));
const modelPath = resolve(SKILL_ROOT, args.model || 'memory/paper/transition_model.json');
const stateLabel = args.state || args.label || null;
const minSupport = Math.max(1, parseInt(args['min-support'] || '3', 10) || 3);
const minTopProb = Math.max(0, Math.min(1, Number(args['min-top-prob'] || 0.55)));
const minWinRate = Math.max(0, Math.min(1, Number(args['min-win-rate'] || 0.55)));
const minAvgPnlUsd = Number(args['min-avg-pnl-usd'] || 0);

if (!stateLabel) {
  console.log(JSON.stringify({
    ok: false,
    advisoryOnly: true,
    message: 'Pass --state <label> from transition_model.json (typically coarseStateLabel for sparse data).',
  }, null, 2));
  process.exit(0);
}

if (!existsSync(modelPath)) {
  console.log(JSON.stringify({
    ok: false,
    advisoryOnly: true,
    message: `Model not found at ${modelPath}. Run paper_transition_model.js first.`,
  }, null, 2));
  process.exit(0);
}

const model = JSON.parse(readFileSync(modelPath, 'utf8'));
const support = Number(model.stateCounts?.[stateLabel] || 0);
const transitions = model.transitionMatrix?.[stateLabel] || {};
const ranked = Object.entries(transitions)
  .map(([label, row]) => [label, typeof row === 'number' ? { probability: row, observedCount: null, pseudoCount: 0 } : row])
  .sort((a, b) => Number(b[1].probability || 0) - Number(a[1].probability || 0));
const [topNextState, topRow] = ranked[0] || [null, null];
const exitStats = model.exitStats?.[stateLabel] || null;

const checks = {
  enoughSupport: support >= minSupport,
  strongTopTransition: Number(topRow?.probability || 0) >= minTopProb,
  favorableExitWinRate: exitStats?.winRate == null ? false : Number(exitStats.winRate) >= minWinRate,
  favorableAvgPnl: exitStats?.avgPnlUsd == null ? false : Number(exitStats.avgPnlUsd) >= minAvgPnlUsd,
};

const reasons = [];
if (!checks.enoughSupport) reasons.push(`support ${support} < min-support ${minSupport}`);
if (!checks.strongTopTransition) reasons.push(`top transition ${(Number(topRow?.probability || 0)).toFixed(3)} < min-top-prob ${minTopProb}`);
if (exitStats?.winRate == null) reasons.push('no exit history for this state');
else if (!checks.favorableExitWinRate) reasons.push(`winRate ${Number(exitStats.winRate).toFixed(3)} < min-win-rate ${minWinRate}`);
if (exitStats?.avgPnlUsd == null) reasons.push('no average pnl history for this state');
else if (!checks.favorableAvgPnl) reasons.push(`avgPnlUsd ${Number(exitStats.avgPnlUsd).toFixed(3)} < min-avg-pnl-usd ${minAvgPnlUsd}`);

const recommendObserve = !checks.enoughSupport || !checks.strongTopTransition || !checks.favorableExitWinRate || !checks.favorableAvgPnl;

console.log(JSON.stringify({
  ok: true,
  advisoryOnly: true,
  stateLabel,
  modelStateKey: model.stateKey || null,
  support,
  topTransition: topNextState ? {
    nextState: topNextState,
    probability: Number(topRow?.probability || 0),
    observedCount: topRow?.observedCount ?? null,
    pseudoCount: topRow?.pseudoCount ?? null,
  } : null,
  exitStats,
  thresholds: {
    minSupport,
    minTopProb,
    minWinRate,
    minAvgPnlUsd,
  },
  checks,
  recommendation: recommendObserve ? 'OBSERVE_ONLY' : 'PAPER_ENTRY_ELIGIBLE',
  note: recommendObserve
    ? `Advisory says observe only: ${reasons.join('; ')}`
    : 'Advisory thresholds passed, but this remains paper-only and should not auto-enable live trading.',
}, null, 2));

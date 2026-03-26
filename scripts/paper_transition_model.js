#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import { SKILL_ROOT } from '../lib/runtime.js';

const args = minimist(process.argv.slice(2));
const regimeStatesPath = resolve(SKILL_ROOT, args.file || 'memory/paper/regime_states.jsonl');
const outputPath = resolve(SKILL_ROOT, args.output || 'memory/paper/transition_model.json');
const tokenIdFilter = args.tokenId || null;
const pretty = Boolean(args.pretty);
const minCount = Math.max(1, parseInt(args['min-count'] || '1', 10) || 1);
const stateKey = String(args['state-key'] || 'coarseStateLabel');
const minSequenceLength = Math.max(1, parseInt(args['min-seq-len'] || '2', 10) || 2);
const priorWeight = Math.max(0, Number(args['prior-weight'] || 1));
const includeStatuses = String(args.statuses || 'opened,open,closed,candidate')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sortByEventOrder(states) {
  const statusRank = { candidate: 0, opened: 1, open: 2, closed: 3 };
  return [...states].sort((a, b) => {
    const cycleDiff = Number(a.cycle || 0) - Number(b.cycle || 0);
    if (cycleDiff !== 0) return cycleDiff;
    const tsDiff = String(a.ts || '').localeCompare(String(b.ts || ''));
    if (tsDiff !== 0) return tsDiff;
    return (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99);
  });
}

function getEpisodeKey(state) {
  if (state.episodeKey) return state.episodeKey;
  if (state.positionId) return state.positionId;
  if (state.tokenId) return `token:${state.tokenId}`;
  return null;
}

function groupStates(records) {
  const grouped = new Map();
  for (const state of records) {
    const key = getEpisodeKey(state);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(state);
  }
  return grouped;
}

function ensureNestedCounter(target, keyA, keyB) {
  if (!target[keyA]) target[keyA] = {};
  if (!target[keyA][keyB]) target[keyA][keyB] = 0;
  target[keyA][keyB] += 1;
}

function enrichLegacyState(state) {
  const enriched = { ...state };
  if (!enriched.stateLabel && enriched.priceBucket && enriched.spreadBucket && enriched.imbalanceBucket && enriched.ageBucket && enriched.markChangeBucket) {
    enriched.stateLabel = [
      `p:${enriched.priceBucket}`,
      `s:${enriched.spreadBucket}`,
      `i:${enriched.imbalanceBucket}`,
      `a:${enriched.ageBucket}`,
      `m:${enriched.markChangeBucket}`,
    ].join('|');
  }
  if (!enriched.modelStateLabel && enriched.stateLabel) enriched.modelStateLabel = enriched.stateLabel;
  if (!enriched.coarseStateLabel && enriched.priceBucket && enriched.spreadBucket && enriched.imbalanceBucket && enriched.markChangeBucket) {
    enriched.coarseStateLabel = [
      `p:${enriched.priceBucket}`,
      `s:${enriched.spreadBucket}`,
      `i:${enriched.imbalanceBucket}`,
      `m:${enriched.markChangeBucket}`,
    ].join('|');
  }
  return enriched;
}

function getStateLabel(state) {
  return state?.[stateKey] || state?.coarseStateLabel || state?.modelStateLabel || state?.stateLabel || null;
}

function buildPriorByStatus(records) {
  const prior = {};
  for (const state of records) {
    const status = state.status || 'unknown';
    const label = getStateLabel(state);
    if (!label) continue;
    ensureNestedCounter(prior, status, label);
  }
  const normalized = {};
  for (const [status, counts] of Object.entries(prior)) {
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    normalized[status] = Object.fromEntries(Object.entries(counts).map(([label, count]) => [label, count / total]));
  }
  return normalized;
}

function normalizeTransitions(grouped, priorByStatus) {
  const stateCounts = {};
  const transitionCounts = {};
  const exitStats = {};
  const sequenceSummaries = [];
  let usableSequences = 0;
  let usableObservations = 0;

  for (const [episodeKey, states] of grouped.entries()) {
    const ordered = sortByEventOrder(states)
      .filter((state) => includeStatuses.includes(state.status || 'unknown'));
    if (ordered.length < minSequenceLength) continue;
    usableSequences += 1;
    usableObservations += ordered.length;

    sequenceSummaries.push({
      episodeKey,
      steps: ordered.length,
      tokenId: ordered[0]?.tokenId || null,
      statuses: ordered.map((s) => s.status),
    });

    for (let i = 0; i < ordered.length; i += 1) {
      const current = ordered[i];
      const currentLabel = getStateLabel(current);
      if (!currentLabel) continue;
      stateCounts[currentLabel] = (stateCounts[currentLabel] || 0) + 1;
      if (current.status === 'closed') {
        if (!exitStats[currentLabel]) exitStats[currentLabel] = { exits: 0, wins: 0, losses: 0, flats: 0, pnlSumUsd: 0 };
        exitStats[currentLabel].exits += 1;
        const pnl = Number(current.realizedPnlUsd);
        if (Number.isFinite(pnl)) {
          exitStats[currentLabel].pnlSumUsd += pnl;
          if (pnl > 0) exitStats[currentLabel].wins += 1;
          else if (pnl < 0) exitStats[currentLabel].losses += 1;
          else exitStats[currentLabel].flats += 1;
        }
      }
      if (i === ordered.length - 1) continue;
      const next = ordered[i + 1];
      const nextLabel = getStateLabel(next);
      if (!nextLabel) continue;
      ensureNestedCounter(transitionCounts, currentLabel, nextLabel);
    }
  }

  const transitionMatrix = {};
  const stateStatuses = {};
  for (const [episodeKey, states] of grouped.entries()) {
    const ordered = sortByEventOrder(states)
      .filter((state) => includeStatuses.includes(state.status || 'unknown'));
    if (ordered.length < minSequenceLength) continue;
    for (const state of ordered) {
      const label = getStateLabel(state);
      if (label && !stateStatuses[label]) stateStatuses[label] = state.status || 'unknown';
    }
  }

  for (const [stateLabel, nextCounts] of Object.entries(transitionCounts)) {
    const total = Object.values(nextCounts).reduce((sum, n) => sum + n, 0);
    if (total < minCount) continue;

    const prior = priorByStatus[stateStatuses[stateLabel]] || priorByStatus.open || {};
    const labels = [...new Set([...Object.keys(nextCounts), ...Object.keys(prior)])];
    const denom = total + priorWeight * labels.length;
    const rows = labels.map((label) => {
      const observed = Number(nextCounts[label] || 0);
      const pseudo = priorWeight * Number(prior[label] || 0);
      const probability = denom > 0 ? (observed + pseudo) / denom : 0;
      return [label, {
        probability,
        observedCount: observed,
        pseudoCount: pseudo,
      }];
    });

    transitionMatrix[stateLabel] = Object.fromEntries(
      rows
        .filter(([, row]) => row.observedCount >= minCount || row.pseudoCount > 0)
        .sort((a, b) => b[1].probability - a[1].probability)
    );
  }

  const exitSummary = Object.fromEntries(
    Object.entries(exitStats).map(([label, stats]) => {
      const denom = stats.wins + stats.losses;
      return [label, {
        ...stats,
        avgPnlUsd: stats.exits ? stats.pnlSumUsd / stats.exits : 0,
        winRate: denom ? stats.wins / denom : null,
      }];
    })
  );

  return {
    stateCounts,
    transitionCounts,
    transitionMatrix,
    exitStats: exitSummary,
    usableSequences,
    usableObservations,
    sequenceSummaries: sequenceSummaries.slice(0, 50),
  };
}

const allStates = readJsonl(regimeStatesPath).map(enrichLegacyState);
const filteredStates = allStates
  .filter((state) => !tokenIdFilter || state.tokenId === tokenIdFilter)
  .filter((state) => getStateLabel(state));

if (!filteredStates.length) {
  console.log(JSON.stringify({
    ok: false,
    message: `No regime states found at ${regimeStatesPath}`,
  }, null, 2));
  process.exit(0);
}

const grouped = groupStates(filteredStates);
const priorByStatus = buildPriorByStatus(filteredStates);
const normalized = normalizeTransitions(grouped, priorByStatus);
const report = {
  ok: true,
  sourceFile: regimeStatesPath,
  tokenFilter: tokenIdFilter,
  stateKey,
  includeStatuses,
  minCount,
  minSequenceLength,
  priorWeight,
  episodeCount: grouped.size,
  observationCount: filteredStates.length,
  priorByStatus,
  ...normalized,
  note: 'Use coarseStateLabel for sparse early paper data. modelStateLabel/stateLabel is more specific but needs more observations.',
};

writeFileSync(outputPath, JSON.stringify(report, null, pretty ? 2 : 0));
console.log(JSON.stringify(report, null, pretty ? 2 : 0));

import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { SKILL_ROOT } from './runtime.js';

const DEFAULT_DECISIONS_PATH = resolve(SKILL_ROOT, 'memory', 'paper', 'decisions.jsonl');
const DEFAULT_OUTPUT_PATH = resolve(SKILL_ROOT, 'memory', 'paper', 'atomic_facts.jsonl');
const DEFAULT_EMBED_ENDPOINT = 'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Embedding-8B';
const SIGNIFICANT_PRICE_MOVE = 0.01;

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asString(value, fallback = 'unknown') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function formatNumber(value, digits = 4, fallback = 'unknown') {
  const numeric = asNumber(value, null);
  return Number.isFinite(numeric) ? numeric.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : fallback;
}

function formatUsd(value, fallback = 'unknown') {
  const numeric = asNumber(value, null);
  return Number.isFinite(numeric) ? `$${formatNumber(numeric, 4)}` : fallback;
}

function formatPercent(value, fallback = 'unknown') {
  const numeric = asNumber(value, null);
  if (!Number.isFinite(numeric)) return fallback;
  const percent = numeric <= 1 && numeric >= 0 ? numeric * 100 : numeric;
  return `${formatNumber(percent, 2)}%`;
}

function parseTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minutesBetween(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date)) return null;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function uniquePush(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function normalizeQuestion(question) {
  return asString(question, 'unknown question');
}

function readJsonlText(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        return { __malformed: true, __line: index + 1 };
      }
    })
    .filter((row) => row && !row.__malformed);
}

async function readJsonlFile(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const text = await readFile(filePath, 'utf8');
    return readJsonlText(text);
  } catch {
    return [];
  }
}

function normalizeDecision(decision) {
  return decision && typeof decision === 'object' ? decision : {};
}

function getDecisionTime(decision) {
  if (!decision || typeof decision !== 'object') return null;
  return parseTime(decision.ts || decision.time || decision.timestamp || decision.createdAt);
}

function sortDecisions(decisions = []) {
  return [...decisions].sort((a, b) => {
    const ta = getDecisionTime(a)?.getTime() ?? 0;
    const tb = getDecisionTime(b)?.getTime() ?? 0;
    return ta - tb;
  });
}

function getQuestion(decisionGroup = []) {
  for (const decision of decisionGroup) {
    const question = decision?.question || decision?.marketQuestion || decision?.title;
    if (question) return String(question);
  }
  return 'unknown question';
}

function getOutcome(decisionGroup = []) {
  for (const decision of decisionGroup) {
    const outcome = decision?.outcome || decision?.side || decision?.positionSide;
    if (outcome) return String(outcome);
  }
  return 'unknown';
}

function getTradePrice(decision, keys = []) {
  for (const key of keys) {
    const numeric = asNumber(decision?.[key], null);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function extractExternalFacts(facts, question, source = {}) {
  const polyProb = asNumber(source?.polymarketProbability ?? source?.polymarketProb ?? source?.polyProbability ?? source?.polyProb ?? source?.probability, null);
  const manifoldProb = asNumber(source?.manifoldProbability ?? source?.manifoldProb, null);
  const refQuestion = asString(source?.similarQuestion ?? source?.referenceQuestion ?? question, question);
  if (Number.isFinite(polyProb) && Number.isFinite(manifoldProb)) {
    facts.push(`Polymarket showed ${formatPercent(polyProb)} while Manifold showed ${formatPercent(manifoldProb)} for similar market '${refQuestion}'.`);
  }

  const polyglobeProb = asNumber(source?.polyglobeProbability ?? source?.polyglobeProb, null);
  if (Number.isFinite(polyglobeProb) && Number.isFinite(polyProb) && !Number.isFinite(manifoldProb)) {
    facts.push(`Polymarket showed ${formatPercent(polyProb)} while Polyglobe showed ${formatPercent(polyglobeProb)} for market '${refQuestion}'.`);
  }
}

function extractDexFacts(facts, source = {}, question) {
  const verdict = asString(source?.verdict || source?.action || source?.positionAdvice?.action, '');
  const reason = asString(source?.reason || source?.summary || '', '');
  const confidence = asNumber(source?.confidence, null);
  if (!verdict && !reason) return;

  const parts = [`Dex review for '${question}'`];
  if (verdict) parts.push(`recommended ${verdict}`);
  if (Number.isFinite(confidence)) parts.push(`with confidence ${formatNumber(confidence, 2)}`);
  let sentence = `${parts.join(' ')}.`;
  if (reason && reason !== 'unknown') sentence += ` ${reason}`;
  facts.push(sentence.trim());
}

export function extractAtomicFacts(decisionGroup) {
  const ordered = sortDecisions(Array.isArray(decisionGroup) ? decisionGroup.map(normalizeDecision) : []);
  const open = ordered.find((decision) => decision.type === 'OPEN' || decision.type === 'BUY') || ordered[0] || {};
  const exit = ordered.findLast((decision) => decision.type === 'EXIT') || null;
  const marks = ordered.filter((decision) => decision.type === 'MARK' || decision.type === 'HOLD');
  const rejects = ordered.filter((decision) => decision.type === 'REJECT' || decision.type === 'SKIP');
  const question = normalizeQuestion(getQuestion(ordered));
  const outcome = asString(getOutcome(ordered));
  const tokenId = asString(open.tokenId || exit?.tokenId || ordered.find((decision) => decision?.tokenId)?.tokenId, 'unknown');
  const startTime = getDecisionTime(open) || getDecisionTime(ordered[0]);
  const endTime = getDecisionTime(exit) || getDecisionTime(ordered[ordered.length - 1]);
  const heldMinutes = asNumber(exit?.heldMinutes, minutesBetween(startTime, endTime));
  const entryPrice = getTradePrice(open, ['entryPrice', 'price', 'fillPrice', 'avgPrice', 'markPrice']);
  const exitPrice = exit ? getTradePrice(exit, ['exitPrice', 'price', 'fillPrice', 'markPrice', 'closePrice']) : null;
  const sizeUsd = getTradePrice(open, ['amountUsd', 'sizeUsd', 'notionalUsd', 'stakeUsd', 'orderUsd', 'budgetUsd']);
  const entryCycle = open.cycle ?? open.entryCycle ?? null;
  const exitCycle = exit?.cycle ?? exit?.exitCycle ?? null;
  const category = asString(open.category || exit?.category || 'unknown');
  const pnlUsd = asNumber(exit?.pnlUsd ?? exit?.pnl ?? marks.at(-1)?.unrealizedPnlUsd, null);
  const exitReason = asString(exit?.reason || exit?.exitReason || exit?.trigger || 'unknown');
  const score = asNumber(open.features?.score ?? open.score, null);
  const spread = asNumber(open.features?.spread ?? open.spread, null);
  const imbalance = asNumber(open.features?.imbalance ?? open.imbalance, null);
  const atomicFacts = [];

  if (Number.isFinite(entryPrice)) {
    atomicFacts.push(`The trader opened a ${outcome} position on '${question}' at ${formatUsd(entryPrice)}${Number.isFinite(sizeUsd) ? ` with ${formatUsd(sizeUsd)} USD` : ''}${entryCycle !== null && entryCycle !== undefined ? ` on cycle ${entryCycle}` : ''}.`);
  } else {
    atomicFacts.push(`The trader opened a ${outcome} position on '${question}'.`);
  }

  const signalBits = [];
  if (category !== 'unknown') signalBits.push(`categorized as ${category}`);
  if (Number.isFinite(score)) signalBits.push(`score ${formatNumber(score, 4)}`);
  if (Number.isFinite(spread)) signalBits.push(`spread ${formatNumber(spread, 4)}`);
  if (Number.isFinite(imbalance)) signalBits.push(`imbalance ${formatNumber(imbalance, 4)}`);
  if (signalBits.length) {
    atomicFacts.push(`'${question}' was ${signalBits.join(', ')}.`);
  }

  let previousPrice = entryPrice;
  let previousTime = startTime;
  let highWater = Number.isFinite(entryPrice) ? entryPrice : null;
  let highWaterMinutes = 0;

  for (const mark of marks) {
    const markPrice = getTradePrice(mark, ['markPrice', 'price', 'entryPrice']);
    const markTime = getDecisionTime(mark);
    const minutes = asNumber(mark.heldMinutes, minutesBetween(startTime, markTime));
    if (Number.isFinite(mark.highWaterPrice) && (highWater === null || mark.highWaterPrice > highWater)) {
      highWater = mark.highWaterPrice;
      highWaterMinutes = Number.isFinite(minutes) ? minutes : 0;
    }
    if (Number.isFinite(markPrice) && (highWater === null || markPrice > highWater)) {
      highWater = markPrice;
      highWaterMinutes = Number.isFinite(minutes) ? minutes : 0;
    }
    if (Number.isFinite(previousPrice) && Number.isFinite(markPrice)) {
      const delta = Math.abs(markPrice - previousPrice);
      if (delta >= SIGNIFICANT_PRICE_MOVE) {
        const elapsed = minutesBetween(previousTime, markTime);
        atomicFacts.push(`The '${question}' position moved from ${formatUsd(previousPrice)} to ${formatUsd(markPrice)} over ${Number.isFinite(elapsed) ? elapsed : 'unknown'} minutes.`);
        previousPrice = markPrice;
        previousTime = markTime || previousTime;
      }
    } else if (Number.isFinite(markPrice)) {
      previousPrice = markPrice;
      previousTime = markTime || previousTime;
    }
  }

  if (Number.isFinite(highWater)) {
    atomicFacts.push(`The position reached a high water mark of ${formatUsd(highWater)}${Number.isFinite(highWaterMinutes) ? ` after ${highWaterMinutes} minutes` : ''}.`);
  }

  const externalSources = [open, ...(open.references ? [open.references] : []), ...(open.polyglobe ? [open.polyglobe] : []), ...(open.manifold ? [open.manifold] : []), ...(open.external ? [open.external] : [])];
  for (const source of externalSources) extractExternalFacts(atomicFacts, question, source || {});

  const dexSources = [open.dexReview, open.dexAdvisory, open.advisory, open.review].filter(Boolean);
  for (const source of dexSources) extractDexFacts(atomicFacts, source, question);

  for (const rejected of rejects) {
    const kind = asString(rejected.type, 'decision').toLowerCase();
    const reason = asString(rejected.reason || rejected.note || rejected.summary, 'unknown');
    atomicFacts.push(`A ${kind} event for '${question}' was logged with reason '${reason}'.`);
  }

  if (exit) {
    atomicFacts.push(`The position was closed via ${exitReason} at ${Number.isFinite(exitPrice) ? formatUsd(exitPrice) : 'unknown price'}${Number.isFinite(pnlUsd) ? ` with a PnL of ${formatUsd(pnlUsd)}` : ''}${Number.isFinite(heldMinutes) ? ` after ${heldMinutes} minutes` : ''}.`);
  }

  return {
    time: (endTime || startTime || new Date(0)).toISOString(),
    question,
    outcome,
    atomic_facts: atomicFacts,
    metadata: {
      tokenId,
      entryCycle,
      exitCycle,
      heldMinutes: Number.isFinite(heldMinutes) ? heldMinutes : null,
      exitReason: exit ? exitReason : null,
      pnlUsd: Number.isFinite(pnlUsd) ? round(pnlUsd, 4) : null,
      category,
      entryPrice: Number.isFinite(entryPrice) ? round(entryPrice, 4) : null,
      exitPrice: Number.isFinite(exitPrice) ? round(exitPrice, 4) : null,
      decisionCount: ordered.length,
    },
  };
}

export function buildFactText(factObj) {
  return Array.isArray(factObj?.atomic_facts) ? factObj.atomic_facts.join(' | ') : '';
}

function extractEmbeddings(payload) {
  if (Array.isArray(payload?.embeddings)) return payload.embeddings;
  if (Array.isArray(payload?.data)) {
    return payload.data.map((item) => item?.embedding).filter(Array.isArray);
  }
  if (Array.isArray(payload)) return payload.filter(Array.isArray);
  return [];
}

export async function embedFacts(factObj) {
  const facts = Array.isArray(factObj?.atomic_facts) ? factObj.atomic_facts.filter(Boolean) : [];
  if (!facts.length) return { ...factObj, fact_embeddings: [] };

  const apiKey = process.env.DEEPINFRA_API_KEY;
  const endpoint = process.env.DEEPINFRA_EMBED_ENDPOINT || DEFAULT_EMBED_ENDPOINT;
  if (!apiKey) return { ...factObj, fact_embeddings: [] };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ inputs: facts }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ...factObj, fact_embeddings: [] };
    }

    const payload = await response.json();
    const embeddings = extractEmbeddings(payload);
    return { ...factObj, fact_embeddings: embeddings.length === facts.length ? embeddings : [] };
  } catch {
    return { ...factObj, fact_embeddings: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function persistAtomicFacts(factObj, filePath = DEFAULT_OUTPUT_PATH) {
  const resolvedPath = resolve(SKILL_ROOT, filePath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await appendFile(resolvedPath, `${JSON.stringify(factObj)}\n`, 'utf8');
  return resolvedPath;
}

function buildTradeGroups(decisions = []) {
  const byToken = new Map();
  for (const decision of sortDecisions(decisions)) {
    const tokenId = decision?.tokenId;
    if (!tokenId) continue;
    if (!byToken.has(tokenId)) byToken.set(tokenId, []);
    byToken.get(tokenId).push(decision);
  }

  const groups = [];
  for (const [tokenId, tokenDecisions] of byToken.entries()) {
    let current = [];
    for (const decision of tokenDecisions) {
      if ((decision.type === 'OPEN' || decision.type === 'BUY') && current.length) {
        current = [];
      }
      current.push(decision);
      if (decision.type === 'EXIT') {
        groups.push({ tokenId, decisions: current });
        current = [];
      }
    }
  }
  return groups;
}

async function loadExistingKeys(outputPath) {
  const rows = await readJsonlFile(outputPath);
  const keys = new Set();
  for (const row of rows) {
    const key = `${row?.metadata?.tokenId || row?.question || 'unknown'}::${row?.time || 'unknown'}`;
    keys.add(key);
  }
  return keys;
}

async function processGroups(groups, outputPath, existingKeys = null) {
  let processed = 0;
  for (const group of groups) {
    const factObj = extractAtomicFacts(group.decisions);
    const key = `${factObj?.metadata?.tokenId || factObj?.question || 'unknown'}::${factObj?.time || 'unknown'}`;
    if (existingKeys?.has(key)) continue;
    const withEmbeddings = await embedFacts(factObj);
    await persistAtomicFacts(withEmbeddings, outputPath);
    existingKeys?.add(key);
    processed += 1;
  }
  return processed;
}

export async function processDecisionsFile(decisionsPath = DEFAULT_DECISIONS_PATH, outputPath = DEFAULT_OUTPUT_PATH) {
  const resolvedDecisions = resolve(SKILL_ROOT, decisionsPath);
  const resolvedOutput = resolve(SKILL_ROOT, outputPath);
  const decisions = await readJsonlFile(resolvedDecisions);
  const groups = buildTradeGroups(decisions);
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, '', 'utf8');
  return processGroups(groups, resolvedOutput);
}

export async function processNewExits(decisionsPath = DEFAULT_DECISIONS_PATH, outputPath = DEFAULT_OUTPUT_PATH) {
  const resolvedDecisions = resolve(SKILL_ROOT, decisionsPath);
  const resolvedOutput = resolve(SKILL_ROOT, outputPath);
  const decisions = await readJsonlFile(resolvedDecisions);
  const groups = buildTradeGroups(decisions);
  const existingKeys = await loadExistingKeys(resolvedOutput);
  return processGroups(groups, resolvedOutput, existingKeys);
}

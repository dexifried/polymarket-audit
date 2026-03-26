import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(MODULE_DIR, '..');
const DEFAULT_DECISIONS_PATH = 'memory/paper/decisions.jsonl';
const DEFAULT_HISTORY_PATH = 'memory/paper/cluster_history.jsonl';
const DAY_MS = 24 * 60 * 60 * 1000;
const FEATURE_KEYS = ['avgScore', 'avgSpread', 'avgImbalance', 'avgPnl', 'winRate', 'avgHoldMinutes'];
const FEATURE_RANGES = {
  avgScore: { min: 0, max: 1 },
  avgSpread: { min: 0, max: 1 },
  avgImbalance: { min: -1, max: 1 },
  avgPnl: { min: -1, max: 1 },
  winRate: { min: 0, max: 1 },
  avgHoldMinutes: { min: 0, max: 24 * 60 },
};
const CATEGORY_KEYWORDS = {
  crypto: ['bitcoin', 'btc', 'eth', 'ethereum', 'crypto', 'blockchain', 'defi', 'token'],
  politics: ['election', 'president', 'senate', 'congress', 'governor', 'republican', 'democrat', 'vote', 'poll'],
  sports: ['nba', 'nfl', 'fifa', 'world cup', 'tournament', 'championship', 'ncaa', 'mls', 'premier'],
  conflict: ['war', 'military', 'nato', 'ukraine', 'israel', 'gaza', 'troops', 'missile', 'invasion', 'sanctions'],
};

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseTimestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeFeatureValue(key, value) {
  const range = FEATURE_RANGES[key] || { min: 0, max: 1 };
  const span = range.max - range.min;
  if (!Number.isFinite(value) || span <= 0) return 0;
  return clamp01((value - range.min) / span);
}

function extractQuestion(decision = {}) {
  return String(decision.question || decision.market_question || decision.market?.question || '').trim();
}

function extractOutcome(decision = {}) {
  return String(decision.outcome || decision.trade?.outcome || '').trim();
}

function extractFeatures(decision = {}) {
  const bag = decision.features && typeof decision.features === 'object' ? decision.features : {};
  return {
    score: toNumber(decision.score ?? bag.score, null),
    spread: toNumber(decision.spread ?? bag.spread, null),
    imbalance: toNumber(decision.imbalance ?? bag.imbalance, null),
    pnl: toNumber(
      decision.realizedPnlUsd
        ?? decision.unrealizedPnlUsd
        ?? decision.pnlUsd
        ?? decision.trade?.realizedPnlUsd
        ?? decision.trade?.pnlUsd,
      null,
    ),
    holdMinutes: toNumber(decision.heldMinutes ?? decision.holdMinutes ?? decision.trade?.heldMinutes, null),
    price: toNumber(
      decision.markPrice
        ?? decision.exitPrice
        ?? decision.entryPrice
        ?? decision.price
        ?? bag.price
        ?? decision.trade?.price,
      null,
    ),
  };
}

function isTradeLikeDecision(decision = {}) {
  const type = String(decision.type || decision.action || '').toUpperCase();
  return ['OPEN', 'EXIT', 'MARK', 'HOLD', 'BUY', 'SKIP', 'REJECT', 'PAUSE', 'NO_TRADE'].includes(type);
}

function inferWin(decision = {}) {
  const pnl = toNumber(
    decision.realizedPnlUsd ?? decision.unrealizedPnlUsd ?? decision.pnlUsd ?? decision.trade?.realizedPnlUsd,
    null,
  );
  if (pnl === null) return null;
  if (pnl > 0) return 1;
  if (pnl < 0) return 0;
  return 0;
}

function determineRegime(count24h, avgSpread) {
  if (count24h > 20 || avgSpread > 0.05) return 'volatile';
  if (count24h >= 5) return 'active';
  return 'quiet';
}

function resolvePath(filePath, fallback) {
  const target = filePath || fallback;
  if (path.isAbsolute(target)) return target;
  return path.resolve(SKILL_ROOT, target);
}

export function classifyDecision(decision = {}) {
  const category = String(decision.category || decision.market?.category || decision.market?.groupItemTitle || '').trim();
  if (category) return category.toLowerCase();

  const haystack = [
    extractQuestion(decision),
    String(decision.note || ''),
    String(decision.market?.description || ''),
  ]
    .join(' ')
    .toLowerCase();

  for (const [name, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return name;
  }

  return 'other';
}

export function buildClusterCentroid(decisions = []) {
  const items = Array.isArray(decisions) ? decisions : [];
  const category = items[0] ? classifyDecision(items[0]) : 'other';
  const scores = [];
  const spreads = [];
  const imbalances = [];
  const pnls = [];
  const holdMinutes = [];
  const prices = [];
  const outcomes = new Map();
  let wins = 0;
  let winSamples = 0;

  for (const decision of items) {
    const features = extractFeatures(decision);
    if (features.score !== null) scores.push(features.score);
    if (features.spread !== null) spreads.push(features.spread);
    if (features.imbalance !== null) imbalances.push(features.imbalance);
    if (features.pnl !== null) pnls.push(features.pnl);
    if (features.holdMinutes !== null) holdMinutes.push(features.holdMinutes);
    if (features.price !== null) prices.push(features.price);

    const win = inferWin(decision);
    if (win !== null) {
      wins += win;
      winSamples += 1;
    }

    const outcome = extractOutcome(decision);
    if (outcome) outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1);
  }

  const avgScore = average(scores);
  const avgSpread = average(spreads);
  const avgImbalance = average(imbalances);
  const avgPnl = average(pnls);
  const avgHoldMinutes = average(holdMinutes);
  const winRate = winSamples ? wins / winSamples : 0;
  const dominantOutcome = [...outcomes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const priceRange = {
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
  };

  return {
    category,
    count: items.length,
    avgScore,
    avgSpread,
    avgImbalance,
    avgPnl,
    winRate,
    avgHoldMinutes,
    priceRange,
    dominantOutcome,
    features: [avgScore, avgSpread, avgImbalance, avgPnl, winRate, avgHoldMinutes],
  };
}

export function cosineSimilarity(a = [], b = []) {
  const size = Math.max(Array.isArray(a) ? a.length : 0, Array.isArray(b) ? b.length : 0, FEATURE_KEYS.length);
  if (!size) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < size; i += 1) {
    const key = FEATURE_KEYS[i] || `f${i}`;
    const av = normalizeFeatureValue(key, toNumber(a[i], 0));
    const bv = normalizeFeatureValue(key, toNumber(b[i], 0));
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (magA === 0 || magB === 0) return 0;
  return clamp01(dot / (Math.sqrt(magA) * Math.sqrt(magB)));
}

export function clusterDecisions(decisions = [], options = {}) {
  const items = (Array.isArray(decisions) ? decisions : []).filter((decision) => decision && typeof decision === 'object');
  const nowMs = parseTimestamp(options.timestamp) ?? Date.now();
  const groups = new Map();

  for (const decision of items) {
    if (!isTradeLikeDecision(decision)) continue;
    const category = classifyDecision(decision);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push({ ...decision, category });
  }

  const clusters = [...groups.entries()]
    .map(([category, grouped]) => ({
      category,
      centroid: buildClusterCentroid(grouped),
      decisions: grouped,
    }))
    .sort((a, b) => b.centroid.count - a.centroid.count || a.category.localeCompare(b.category));

  const byCategory = {};
  let overallTrades24h = 0;
  let overallSpreadSum = 0;
  let overallSpreadCount = 0;

  for (const cluster of clusters) {
    const trades24h = cluster.decisions.filter((decision) => {
      const ts = parseTimestamp(decision.ts || decision.timestamp);
      return ts !== null && nowMs - ts <= DAY_MS && nowMs - ts >= 0;
    });
    const count24h = trades24h.length;
    const avgSpread24h = average(
      trades24h
        .map((decision) => extractFeatures(decision).spread)
        .filter((value) => value !== null),
    );
    byCategory[cluster.category] = determineRegime(count24h, avgSpread24h || cluster.centroid.avgSpread);
    overallTrades24h += count24h;
    if (Number.isFinite(avgSpread24h) && avgSpread24h > 0) {
      overallSpreadSum += avgSpread24h;
      overallSpreadCount += 1;
    } else if (Number.isFinite(cluster.centroid.avgSpread) && cluster.centroid.avgSpread > 0) {
      overallSpreadSum += cluster.centroid.avgSpread;
      overallSpreadCount += 1;
    }
  }

  return {
    clusters,
    regime: {
      overall: determineRegime(overallTrades24h, overallSpreadCount ? overallSpreadSum / overallSpreadCount : 0),
      byCategory,
    },
    timestamp: new Date(nowMs).toISOString(),
  };
}

export function detectRegimeShift(currentCluster, previousCluster) {
  const current = currentCluster?.centroid || currentCluster || {};
  const previous = previousCluster?.centroid || previousCluster || {};
  const category = current.category || currentCluster?.category || previous.category || previousCluster?.category || 'other';
  const thresholds = {
    avgScore: 0.15,
    avgSpread: 0.02,
    avgImbalance: 0.2,
    avgPnl: 0.05,
    winRate: 0.2,
    avgHoldMinutes: 60,
  };

  const changes = FEATURE_KEYS.map((field) => {
    const from = toNumber(previous[field], 0);
    const to = toNumber(current[field], 0);
    const delta = to - from;
    return { field, from, to, delta };
  }).filter((change) => Math.abs(change.delta) >= (thresholds[change.field] || 0.1));

  const spreadJump = changes.some((change) => change.field === 'avgSpread' && Math.abs(change.delta) >= 0.04);
  const winDrop = changes.some((change) => change.field === 'winRate' && Math.abs(change.delta) >= 0.3);
  const severity = !changes.length ? 'low' : spreadJump || winDrop || changes.length >= 3 ? 'high' : 'medium';

  return {
    shifted: changes.length > 0,
    category,
    changes,
    severity,
  };
}

export function findBestThemes(clusters = []) {
  return (Array.isArray(clusters) ? clusters : [])
    .map((cluster) => {
      const centroid = cluster?.centroid || cluster || {};
      return {
        category: cluster?.category || centroid.category || 'other',
        winRate: toNumber(centroid.winRate, 0),
        avgPnl: toNumber(centroid.avgPnl, 0),
        score: toNumber(centroid.winRate, 0) * toNumber(centroid.avgPnl, 0),
        count: toNumber(centroid.count, 0),
      };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count || a.category.localeCompare(b.category));
}

function parseJsonLines(content = '') {
  return String(content)
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

export async function loadAndCluster(decisionsPath = DEFAULT_DECISIONS_PATH, options = {}) {
  const filePath = resolvePath(decisionsPath, DEFAULT_DECISIONS_PATH);
  let content = '';
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return clusterDecisions([], options);
    }
    throw error;
  }

  // Cap to last 500 lines to avoid token overflow in LLM calls
  const lines = parseJsonLines(content);
  const capped = lines.slice(-500);
  return clusterDecisions(capped, options);
}

export async function persistCluster(result, filePath = DEFAULT_HISTORY_PATH) {
  const targetPath = resolvePath(filePath, DEFAULT_HISTORY_PATH);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const payload = JSON.stringify({
    timestamp: result?.timestamp || new Date().toISOString(),
    regime: result?.regime || { overall: 'quiet', byCategory: {} },
    clusters: Array.isArray(result?.clusters)
      ? result.clusters.map((cluster) => ({
          category: cluster.category,
          centroid: cluster.centroid,
        }))
      : [],
  });
  await appendFile(targetPath, `${payload}\n`, 'utf8');
  return targetPath;
}

export default {
  buildClusterCentroid,
  cosineSimilarity,
  clusterDecisions,
  detectRegimeShift,
  findBestThemes,
  loadAndCluster,
  persistCluster,
  classifyDecision,
};

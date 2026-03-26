import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const DEFAULT_PROFILES_PATH = resolve(SKILL_ROOT, 'memory', 'paper', 'agent_profiles.json');
const RECENT_VERDICTS_LIMIT = 20;

const ROLE_MAPPING = Object.freeze({
  judge: 'decision_maker',
  watchman: 'info_summarizer',
  dex: 'opinion_leader',
  collector: 'coordinator',
  retriever: 'execution_promoter',
  trader: 'core_contributor',
});

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function asString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function capitalize(value) {
  const text = asString(value);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Unknown';
}

function classifyResult(pnl) {
  const numericPnl = asNumber(pnl, null);
  if (!Number.isFinite(numericPnl)) return 'pending';
  if (numericPnl > 0) return 'win';
  if (numericPnl < 0) return 'loss';
  return 'flat';
}

function computeWinRate(wins, losses) {
  const decided = Math.max(0, Number(wins || 0) + Number(losses || 0));
  return decided ? Number((Number(wins || 0) / decided).toFixed(3)) : 0;
}

function computeAvgPnl(totalRealizedPnl, closedCount) {
  const total = asNumber(totalRealizedPnl, 0) || 0;
  const count = Math.max(0, Number(closedCount || 0));
  return count ? Number((total / count).toFixed(4)) : 0;
}

function getTopicStatus(topicStats = {}) {
  const wins = Number(topicStats.wins || 0);
  const losses = Number(topicStats.losses || 0);
  const pending = Number(topicStats.pending || 0);
  const decided = wins + losses;

  if (wins >= 3 && losses === 0 && pending === 0) return 'implemented';
  if (!decided && pending > 0) return 'exploring';
  if (wins > 0 && losses > 0) return 'disagreement';
  if (wins > 0 && losses === 0) return 'consensus';
  if (losses > 0 && wins === 0) return 'disagreement';
  return decided ? 'consensus' : 'exploring';
}

function normalizeTopicStats(topicStats = {}) {
  const wins = Number(topicStats.wins || 0);
  const losses = Number(topicStats.losses || 0);
  const pending = Number(topicStats.pending || 0);
  return {
    wins,
    losses,
    pending,
    winRate: computeWinRate(wins, losses),
    topicStatus: asString(topicStats.topicStatus) || getTopicStatus({ wins, losses, pending }),
  };
}

function normalizeVerdict(verdict = {}) {
  return {
    ts: asString(verdict.ts, nowIso()),
    tokenId: asString(verdict.tokenId),
    action: asString(verdict.action, 'UNKNOWN'),
    question: asString(verdict.question, 'Unknown market'),
    topic: asString(verdict.topic, 'other'),
    outcome: asString(verdict.outcome),
    result: asString(verdict.result, 'pending'),
    pnl: asNumber(verdict.pnl, null),
    reason: asString(verdict.reason),
    phase: asString(verdict.phase, verdict.result === 'pending' ? 'entry' : 'exit'),
  };
}

function createEmptyProfile(agentName) {
  const agent = asString(agentName, 'unknown').toLowerCase();
  return {
    agent,
    role: ROLE_MAPPING[agent] || 'unknown',
    totalDecisions: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    flat: 0,
    winRate: 0,
    avgPnl: 0,
    totalRealizedPnl: 0,
    closedDecisions: 0,
    recentVerdicts: [],
    topicPerformance: {},
    openDecisions: [],
    lastUpdated: null,
  };
}

function normalizeProfile(agentName, profile = {}) {
  const base = createEmptyProfile(agentName);
  const topicPerformance = Object.fromEntries(
    Object.entries(asObject(profile.topicPerformance)).map(([topic, stats]) => [topic, normalizeTopicStats(stats)])
  );
  const openDecisions = Array.isArray(profile.openDecisions)
    ? profile.openDecisions.map((decision) => ({
        ts: asString(decision.ts, nowIso()),
        tokenId: asString(decision.tokenId),
        action: asString(decision.action, 'UNKNOWN'),
        question: asString(decision.question, 'Unknown market'),
        topic: asString(decision.topic, 'other'),
        outcome: asString(decision.outcome),
        entryPrice: asNumber(decision.entryPrice, null),
        context: asObject(decision.context),
      }))
      .filter((decision) => decision.tokenId)
    : [];

  const recentVerdicts = Array.isArray(profile.recentVerdicts)
    ? profile.recentVerdicts.map(normalizeVerdict).slice(-RECENT_VERDICTS_LIMIT)
    : [];

  const wins = Number(profile.wins || 0);
  const losses = Number(profile.losses || 0);
  const pending = Number(profile.pending ?? openDecisions.length ?? 0);
  const flat = Number(profile.flat || 0);
  const totalRealizedPnl = asNumber(profile.totalRealizedPnl, 0) || 0;
  const closedDecisions = Number(profile.closedDecisions || wins + losses + flat);

  return {
    ...base,
    ...profile,
    agent: base.agent,
    role: asString(profile.role, base.role),
    totalDecisions: Number(profile.totalDecisions || wins + losses + pending + flat),
    wins,
    losses,
    pending,
    flat,
    totalRealizedPnl: Number(totalRealizedPnl.toFixed(4)),
    closedDecisions,
    avgPnl: computeAvgPnl(totalRealizedPnl, closedDecisions),
    winRate: computeWinRate(wins, losses),
    topicPerformance,
    recentVerdicts,
    openDecisions,
    lastUpdated: asString(profile.lastUpdated) || null,
  };
}

function normalizeProfiles(profiles = {}) {
  const safeProfiles = asObject(profiles);
  return Object.fromEntries(Object.entries(safeProfiles).map(([agent, profile]) => [agent, normalizeProfile(agent, profile)]));
}

function recalcProfile(profile) {
  return normalizeProfile(profile.agent, profile);
}

function pushRecentVerdict(profile, verdict) {
  profile.recentVerdicts = [...(profile.recentVerdicts || []), normalizeVerdict(verdict)].slice(-RECENT_VERDICTS_LIMIT);
}

function ensureTopic(profile, topic) {
  const normalizedTopic = asString(topic, 'other').toLowerCase();
  if (!profile.topicPerformance[normalizedTopic]) {
    profile.topicPerformance[normalizedTopic] = normalizeTopicStats({});
  }
  return normalizedTopic;
}

function closeOpenDecision(profile, tokenId) {
  const openDecisions = Array.isArray(profile.openDecisions) ? profile.openDecisions : [];
  const index = openDecisions.findIndex((decision) => decision.tokenId === tokenId);
  if (index < 0) return { matched: null, openDecisions };
  const matched = openDecisions[index];
  return {
    matched,
    openDecisions: [...openDecisions.slice(0, index), ...openDecisions.slice(index + 1)],
  };
}

function finalizeOutcome(profile, decisionEvent) {
  const tokenId = asString(decisionEvent.tokenId);
  const { matched, openDecisions } = closeOpenDecision(profile, tokenId);
  const topic = ensureTopic(profile, decisionEvent.context?.topic || matched?.topic || classifyTopic(decisionEvent.question || matched?.question));
  const result = classifyResult(decisionEvent.pnl);
  const topicStats = normalizeTopicStats(profile.topicPerformance[topic]);

  profile.openDecisions = openDecisions;
  profile.pending = Math.max(0, openDecisions.length);

  if (result === 'win') {
    profile.wins += 1;
    topicStats.wins += 1;
  } else if (result === 'loss') {
    profile.losses += 1;
    topicStats.losses += 1;
  } else if (result === 'flat') {
    profile.flat += 1;
  } else {
    profile.pending += 1;
    topicStats.pending += 1;
  }

  if (result !== 'pending') {
    profile.closedDecisions += 1;
    profile.totalRealizedPnl = Number(((profile.totalRealizedPnl || 0) + (asNumber(decisionEvent.pnl, 0) || 0)).toFixed(4));
  }

  topicStats.pending = Math.max(0, Number(topicStats.pending || 0) - (matched ? 1 : 0));
  profile.topicPerformance[topic] = normalizeTopicStats(topicStats);

  pushRecentVerdict(profile, {
    ts: asString(decisionEvent.ts, nowIso()),
    tokenId,
    action: asString(decisionEvent.action || matched?.action, 'UNKNOWN'),
    question: asString(decisionEvent.question || matched?.question, 'Unknown market'),
    topic,
    outcome: asString(decisionEvent.outcome || matched?.outcome),
    result,
    pnl: asNumber(decisionEvent.pnl, null),
    reason: asString(decisionEvent.reason),
    phase: 'exit',
  });
}

export function getRoleMapping() {
  return { ...ROLE_MAPPING };
}

export function classifyTopic(question) {
  const q = asString(question).toLowerCase();
  if (/bitcoin|btc|crypto|ethereum|\beth\b|solana|token|airdrop/.test(q)) return 'crypto';
  if (/election|senate|governor|president|congress|parliament|mayor|primary/.test(q)) return 'politics';
  if (/\b(nba|nfl|mlb|nhl|soccer|football|championship|playoffs|world cup|ufc|boxing)\b/.test(q)) return 'sports';
  if (/war|conflict|military|nato|ukraine|israel|gaza|troops|missile|invasion|sanctions/.test(q)) return 'conflict';
  return 'other';
}

export function updateAgentProfile(profiles = {}, decisionEvent = {}) {
  const nextProfiles = normalizeProfiles(profiles);
  const agent = asString(decisionEvent.agent, 'unknown').toLowerCase();
  const ts = asString(decisionEvent.ts, nowIso());
  const question = asString(decisionEvent.question, 'Unknown market');
  const tokenId = asString(decisionEvent.tokenId);
  const action = asString(decisionEvent.action, 'UNKNOWN');
  const context = asObject(decisionEvent.context);
  const topic = asString(context.topic, classifyTopic(question)).toLowerCase();
  const profile = nextProfiles[agent] ? normalizeProfile(agent, nextProfiles[agent]) : createEmptyProfile(agent);

  if (!nextProfiles[agent]) nextProfiles[agent] = profile;

  profile.role = ROLE_MAPPING[agent] || profile.role || 'unknown';
  profile.lastUpdated = ts;

  const isOutcomeEvent = decisionEvent.exitPrice !== null && decisionEvent.exitPrice !== undefined
    || decisionEvent.pnl !== null && decisionEvent.pnl !== undefined
    || asString(decisionEvent.reason) !== '';

  if (!isOutcomeEvent) {
    profile.totalDecisions += 1;
    profile.pending = Math.max(0, Number(profile.pending || 0) + 1);
    profile.openDecisions = [
      ...(Array.isArray(profile.openDecisions) ? profile.openDecisions.filter((openDecision) => openDecision.tokenId !== tokenId) : []),
      {
        ts,
        tokenId,
        action,
        question,
        topic,
        outcome: asString(decisionEvent.outcome),
        entryPrice: asNumber(decisionEvent.entryPrice, null),
        context,
      },
    ].filter((openDecision) => openDecision.tokenId);

    const topicStats = normalizeTopicStats(profile.topicPerformance[topic]);
    topicStats.pending += 1;
    profile.topicPerformance[topic] = normalizeTopicStats(topicStats);

    pushRecentVerdict(profile, {
      ts,
      tokenId,
      action,
      question,
      topic,
      outcome: asString(decisionEvent.outcome),
      result: 'pending',
      pnl: null,
      reason: '',
      phase: 'entry',
    });
  } else {
    finalizeOutcome(profile, {
      ...decisionEvent,
      ts,
      tokenId,
      action,
      question,
      context: { ...context, topic },
    });
  }

  nextProfiles[agent] = recalcProfile(profile);
  return nextProfiles;
}

export function loadProfiles(filePath = DEFAULT_PROFILES_PATH) {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) return {};

  try {
    const raw = readFileSync(resolvedPath, 'utf8');
    if (!raw.trim()) return {};
    return normalizeProfiles(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveProfiles(profiles = {}, filePath = DEFAULT_PROFILES_PATH) {
  const resolvedPath = resolve(filePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const normalized = normalizeProfiles(profiles);
  writeFileSync(resolvedPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

export function recordDecision(agent, action, position = {}, filePath = DEFAULT_PROFILES_PATH) {
  const profiles = loadProfiles(filePath);
  const event = {
    ts: asString(position.ts, nowIso()),
    agent: asString(agent, 'unknown').toLowerCase(),
    action: asString(action, 'UNKNOWN'),
    tokenId: asString(position.tokenId || position.id || position.marketId),
    question: asString(position.question, 'Unknown market'),
    outcome: asString(position.outcome || position.side),
    entryPrice: asNumber(position.entryPrice ?? position.price, null),
    exitPrice: null,
    pnl: null,
    reason: '',
    context: asObject(position.context),
  };

  const updated = updateAgentProfile(profiles, event);
  saveProfiles(updated, filePath);
  return updated;
}

export function recordOutcome(agent, tokenId, exitPrice, pnl, reason = '', filePath = DEFAULT_PROFILES_PATH) {
  const profiles = loadProfiles(filePath);
  const agentName = asString(agent, 'unknown').toLowerCase();
  const profile = normalizeProfile(agentName, profiles[agentName]);
  const openDecision = (profile.openDecisions || []).find((decision) => decision.tokenId === asString(tokenId));

  const event = {
    ts: nowIso(),
    agent: agentName,
    action: asString(openDecision?.action, 'UNKNOWN'),
    tokenId: asString(tokenId),
    question: asString(openDecision?.question, 'Unknown market'),
    outcome: asString(openDecision?.outcome),
    entryPrice: asNumber(openDecision?.entryPrice, null),
    exitPrice: asNumber(exitPrice, null),
    pnl: asNumber(pnl, null),
    reason: asString(reason),
    context: { ...asObject(openDecision?.context), topic: asString(openDecision?.topic, 'other') },
  };

  const updated = updateAgentProfile(profiles, event);
  saveProfiles(updated, filePath);
  return updated;
}

export function getAgentSummary(profiles = {}, agentName) {
  const normalized = normalizeProfiles(profiles);
  const agent = asString(agentName, '').toLowerCase();
  const profile = normalized[agent];
  if (!profile) return `${capitalize(agentName)}: no profile data.`;

  const bestTopicEntry = Object.entries(profile.topicPerformance || {})
    .sort((a, b) => {
      const rateDiff = (b[1]?.winRate || 0) - (a[1]?.winRate || 0);
      if (rateDiff !== 0) return rateDiff;
      const aSample = Number(a[1]?.wins || 0) + Number(a[1]?.losses || 0);
      const bSample = Number(b[1]?.wins || 0) + Number(b[1]?.losses || 0);
      return bSample - aSample;
    })[0];

  const recent = (profile.recentVerdicts || [])
    .slice(-2)
    .map((verdict) => `${verdict.action} → ${verdict.result}`)
    .join(', ');

  const bestTopic = bestTopicEntry
    ? ` Best: ${bestTopicEntry[0]} (${((bestTopicEntry[1]?.winRate || 0) * 100).toFixed(1)}%).`
    : '';

  return `${capitalize(profile.agent)}: ${profile.totalDecisions} decisions, ${((profile.winRate || 0) * 100).toFixed(1)}% win rate, avg PnL $${(profile.avgPnl || 0).toFixed(2)}.${bestTopic}${recent ? ` Recent: ${recent}.` : ''}`;
}

export function getNetworkSummary(profiles = {}) {
  const normalized = normalizeProfiles(profiles);
  const summaries = Object.values(normalized)
    .sort((a, b) => {
      const rateDiff = (b.winRate || 0) - (a.winRate || 0);
      if (rateDiff !== 0) return rateDiff;
      return (b.totalDecisions || 0) - (a.totalDecisions || 0);
    })
    .map((profile) => getAgentSummary(normalized, profile.agent));

  return summaries.join('\n');
}

export { DEFAULT_PROFILES_PATH };

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { SKILL_ROOT } from './runtime.js';
import { reflectionPrompt } from './prompt_templates.js';
import { validateReflection } from './schema.js';

const PAPER_DIR = resolve(SKILL_ROOT, 'memory', 'paper');
const REFLECTIONS_PATH = resolve(PAPER_DIR, 'agent_reflections.jsonl');
const LLM_CALLER_PATH = resolve(SKILL_ROOT, 'scripts', 'llm_caller.js');
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was', 'were', 'will', 'with', 'would', 'who', 'what', 'when', 'where', 'why', 'how', 'does', 'did', 'do', 'can', 'could', 'should', 'about', 'than', 'then', 'after', 'before', 'over', 'under', 'not', 'yes', 'no',
]);

function ensurePaperDir() {
  mkdirSync(PAPER_DIR, { recursive: true });
}

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(value) {
  return [...new Set(normalizeText(value).split(' ').filter((word) => word.length >= 3 && !STOPWORDS.has(word)))];
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
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

function getBundleContext(evidenceBundle = {}) {
  return {
    question: String(evidenceBundle?.market?.question || ''),
    category: String(evidenceBundle?.market?.category || 'other').toLowerCase(),
    side: String(evidenceBundle?.candidate?.outcome || '').toLowerCase(),
    price: asNumber(evidenceBundle?.candidate?.price, null),
  };
}

function priceBucket(price) {
  const numeric = asNumber(price, null);
  if (!Number.isFinite(numeric)) return 'unknown';
  if (numeric < 0.2) return 'very_low';
  if (numeric < 0.4) return 'low';
  if (numeric < 0.6) return 'mid';
  if (numeric < 0.8) return 'high';
  return 'very_high';
}

function roleMultiplier(role, reflection = {}, bundle = {}) {
  const normalizedRole = String(role || '').toLowerCase();
  const reflectionSide = String(reflection?.side || '').toLowerCase();
  const bundleSide = String(bundle?.side || '').toLowerCase();
  const result = String(reflection?.result || '').toLowerCase();

  if (normalizedRole.includes('bull')) {
    if (reflectionSide && bundleSide && reflectionSide === bundleSide) return result === 'good' ? 1.25 : 1.05;
    if (reflectionSide && bundleSide && reflectionSide !== bundleSide) return result === 'bad' ? 1.15 : 0.9;
  }
  if (normalizedRole.includes('bear')) {
    if (reflectionSide && bundleSide && reflectionSide !== bundleSide) return result === 'good' ? 1.25 : 1.05;
    if (reflectionSide && bundleSide && reflectionSide === bundleSide) return result === 'bad' ? 1.15 : 0.9;
  }
  if (normalizedRole.includes('risk') || normalizedRole.includes('manager')) {
    if (result === 'bad') return 1.2;
    if (result === 'mixed') return 1.1;
  }
  return 1;
}

function scoreReflection(role, reflection, bundleContext) {
  let score = 0;
  const reflectionCategory = String(reflection?.category || '').toLowerCase();
  const reflectionSide = String(reflection?.side || '').toLowerCase();
  const reflectionQuestionTokens = tokenize(reflection?.marketQuestion || '');
  const bundleQuestionTokens = tokenize(bundleContext.question);
  const bundleTokenSet = new Set(bundleQuestionTokens);
  const keywordOverlap = reflectionQuestionTokens.filter((token) => bundleTokenSet.has(token));

  if (reflectionCategory && bundleContext.category && reflectionCategory === bundleContext.category) score += 4;
  score += Math.min(keywordOverlap.length, 6) * 1.5;
  if (reflectionSide && bundleContext.side && reflectionSide === bundleContext.side) score += 2;
  else if (reflectionSide && bundleContext.side && reflectionSide !== bundleContext.side) score += 0.5;

  const reflectionEntry = asNumber(reflection?.entryPrice, null);
  if (Number.isFinite(reflectionEntry) && Number.isFinite(bundleContext.price)) {
    if (priceBucket(reflectionEntry) === priceBucket(bundleContext.price)) score += 2;
    const distance = Math.abs(reflectionEntry - bundleContext.price);
    score += Math.max(0, 1.5 - (distance * 5));
  }

  score *= roleMultiplier(role, reflection, bundleContext);
  return Number(score.toFixed(4));
}

function normalizedProceedDecision(value) {
  const decision = String(value || '').toUpperCase();
  return ['APPROVE', 'REDUCE', 'PROCEED', 'BUY', 'YES'].includes(decision);
}

function extractRoleMeta(reflection, role) {
  return reflection?.roleDecisions?.[role] || reflection?.roleOutputs?.[role] || null;
}

export function storeReflection(reflection) {
  ensurePaperDir();
  appendFileSync(REFLECTIONS_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...reflection })}\n`);
  return REFLECTIONS_PATH;
}

export function retrieveMemories(role, evidenceBundle, n = 3) {
  const bundleContext = getBundleContext(evidenceBundle);
  const reflections = readJsonl(REFLECTIONS_PATH);
  if (!reflections.length) return [];

  return reflections
    .map((reflection) => ({
      ...reflection,
      memoryScore: scoreReflection(role, reflection, bundleContext),
    }))
    .filter((reflection) => reflection.memoryScore > 0)
    .sort((a, b) => b.memoryScore - a.memoryScore)
    .slice(0, Math.max(0, Number(n) || 3));
}

export function formatMemories(memories = []) {
  if (!Array.isArray(memories) || !memories.length) return '';
  return memories
    .map((memory, index) => {
      const bits = [
        `#${index + 1}`,
        memory?.category ? `category=${memory.category}` : null,
        memory?.side ? `side=${memory.side}` : null,
        Number.isFinite(asNumber(memory?.entryPrice, null)) ? `entry=${memory.entryPrice}` : null,
        Number.isFinite(asNumber(memory?.exitPrice, null)) ? `exit=${memory.exitPrice}` : null,
        Number.isFinite(asNumber(memory?.pnlUsd, null)) ? `pnlUsd=${memory.pnlUsd}` : null,
        memory?.result ? `result=${memory.result}` : null,
      ].filter(Boolean).join(' | ');

      const lessons = [
        Array.isArray(memory?.whatWorked) && memory.whatWorked.length ? `worked: ${memory.whatWorked.join('; ')}` : null,
        Array.isArray(memory?.whatFailed) && memory.whatFailed.length ? `failed: ${memory.whatFailed.join('; ')}` : null,
        memory?.futureRule ? `future_rule: ${memory.futureRule}` : null,
        Array.isArray(memory?.tags) && memory.tags.length ? `tags: ${memory.tags.join(', ')}` : null,
      ].filter(Boolean).join(' | ');

      return `${bits}\nquestion: ${memory?.marketQuestion || 'unknown'}${lessons ? `\nlessons: ${lessons}` : ''}`;
    })
    .join('\n\n');
}

export function generateReflection(closedTrade, entryBundle = {}, exitData = {}) {
  const requestTrade = {
    ...closedTrade,
    exitData,
    pnlUsd: asNumber(exitData?.pnlUsd, asNumber(closedTrade?.pnlUsd, 0)),
    exitPrice: asNumber(exitData?.exitPrice, asNumber(closedTrade?.exitPrice, null)),
    exitReason: String(exitData?.reason || closedTrade?.exitReason || ''),
  };

  const messages = reflectionPrompt(requestTrade, entryBundle);
  const stdout = execFileSync('node', [LLM_CALLER_PATH], {
    input: JSON.stringify({ messages }),
    encoding: 'utf8',
    timeout: Number(process.env.TRADING_AGENTS_LLM_TIMEOUT_MS || 120000),
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });

  const validated = validateReflection(String(stdout || '').trim());
  const enriched = {
    marketQuestion: closedTrade?.question || closedTrade?.marketQuestion || entryBundle?.market?.question || 'unknown',
    category: closedTrade?.category || entryBundle?.market?.category || 'other',
    side: closedTrade?.outcome || closedTrade?.side || entryBundle?.candidate?.outcome || '',
    entryPrice: asNumber(closedTrade?.entryPrice, asNumber(entryBundle?.candidate?.price, null)),
    exitPrice: requestTrade.exitPrice,
    exitReason: requestTrade.exitReason,
    pnlUsd: requestTrade.pnlUsd,
    result: validated.cleaned.result,
    whatWorked: validated.cleaned.whatWorked,
    whatFailed: validated.cleaned.whatFailed,
    futureRule: validated.cleaned.futureRule,
    tags: validated.cleaned.tags,
    confidence: validated.cleaned.confidence,
    tradeId: closedTrade?.id || closedTrade?.tradeId || null,
    entryBundle,
    roleDecisions: closedTrade?.roleDecisions || entryBundle?.decisionContext?.roleDecisions || {},
    roleOutputs: closedTrade?.roleOutputs || entryBundle?.decisionContext?.roleOutputs || {},
  };

  storeReflection(enriched);
  return enriched;
}

export function getRolePerformance(role) {
  const reflections = readJsonl(REFLECTIONS_PATH);
  const targetRole = String(role || '').trim();
  const relevant = reflections.filter((reflection) => extractRoleMeta(reflection, targetRole));
  const totalTrades = relevant.length;
  const profitableTrades = relevant.filter((reflection) => Number(reflection?.pnlUsd || 0) > 0);
  const proceeded = relevant.filter((reflection) => normalizedProceedDecision(extractRoleMeta(reflection, targetRole)?.decision));
  const proceededProfitable = proceeded.filter((reflection) => Number(reflection?.pnlUsd || 0) > 0);
  const averagePnl = totalTrades ? (relevant.reduce((sum, reflection) => sum + Number(reflection?.pnlUsd || 0), 0) / totalTrades) : 0;

  let directionalTrades = 0;
  let directionalCorrect = 0;
  if (['bull_researcher', 'bear_researcher', 'research_manager'].includes(targetRole)) {
    for (const reflection of relevant) {
      const meta = extractRoleMeta(reflection, targetRole) || {};
      const pnl = Number(reflection?.pnlUsd || 0);
      if (!Number.isFinite(pnl) || pnl === 0) continue;
      const side = String(meta?.side || meta?.preferred_side || '').toUpperCase();
      const marketSide = String(reflection?.side || '').toUpperCase();
      if (!side || !marketSide) continue;
      directionalTrades += 1;
      if ((targetRole === 'bear_researcher' && side !== marketSide && pnl > 0) || (targetRole !== 'bear_researcher' && side === marketSide && pnl > 0)) {
        directionalCorrect += 1;
      }
    }
  }

  return {
    role: targetRole,
    totalTrades,
    proceedTrades: proceeded.length,
    proceedWinRate: proceeded.length ? Number((proceededProfitable.length / proceeded.length).toFixed(4)) : 0,
    overallWinRate: totalTrades ? Number((profitableTrades.length / totalTrades).toFixed(4)) : 0,
    averagePnl: Number(averagePnl.toFixed(4)),
    directionalAccuracy: directionalTrades ? Number((directionalCorrect / directionalTrades).toFixed(4)) : null,
  };
}

export function getPerformanceSummary() {
  const reflections = readJsonl(REFLECTIONS_PATH);
  const roles = new Set();
  for (const reflection of reflections) {
    for (const role of Object.keys(reflection?.roleDecisions || {})) roles.add(role);
    for (const role of Object.keys(reflection?.roleOutputs || {})) roles.add(role);
  }

  const roleStats = Object.fromEntries([...roles].sort().map((role) => [role, getRolePerformance(role)]));
  return {
    totalReflections: reflections.length,
    roles: roleStats,
  };
}

export default {
  storeReflection,
  retrieveMemories,
  formatMemories,
  generateReflection,
  getRolePerformance,
  getPerformanceSummary,
};

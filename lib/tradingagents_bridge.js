import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { SKILL_ROOT } from './runtime.js';
import {
  contextAnalystPrompt,
  socialAnalystPrompt,
  newsAnalystPrompt,
  resolutionAnalystPrompt,
  bullResearcherPrompt,
  bearResearcherPrompt,
  researchManagerPrompt,
  traderPrompt,
  riskPanelPrompt,
  aggressiveRiskPrompt,
  conservativeRiskPrompt,
  neutralRiskPrompt,
  riskManagerFinalPrompt,
} from './prompt_templates.js';
import {
  validateAnalystReport,
  validateSocialAnalyst,
  validateNewsAnalyst,
  validateResearchOutput,
  validateTraderProposal,
  validateRiskOutput,
  validateAggressiveRisk,
  validateConservativeRisk,
  validateNeutralRisk,
  validateRiskManagerFinal,
} from './schema.js';
import { retrieveMemories, formatMemories, getPerformanceSummary } from './agent_memory.js';

const PAPER_DIR = resolve(SKILL_ROOT, 'memory', 'paper');
const OUTPUT_DIR = resolve(PAPER_DIR, 'agent_outputs');
const CACHE_DIR = resolve(PAPER_DIR, 'agent_cache');
const DECISION_BUNDLES_PATH = resolve(PAPER_DIR, 'decision_bundles.jsonl');
const ROLE_TTLS_MS = {
  context_analyst: 5 * 60 * 1000,
  social_analyst: 5 * 60 * 1000,
  news_analyst: 5 * 60 * 1000,
  resolution_analyst: 10 * 60 * 1000,
};

function ensureDir() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(PAPER_DIR, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[.:]/g, '-');
}

function parseMaybeJson(text) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return text; }
}

function cacheFile(roleName, cacheKey) {
  return resolve(CACHE_DIR, `${roleName}-${cacheKey}.json`);
}

function summarizeRoleOutput(roleOutput = {}) {
  return {
    role: roleOutput.role,
    decision: roleOutput.decision,
    side: roleOutput.side,
    confidence: roleOutput.confidence,
    summary: roleOutput.summary || roleOutput.thesis || roleOutput.reason || roleOutput.top_edge || '',
    top_risk: roleOutput.top_risk,
    stance: roleOutput.stance,
    cached: Boolean(roleOutput.cached),
  };
}

function appendJsonl(filePath, obj) {
  appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function getCacheTtl(roleName) {
  return ROLE_TTLS_MS[roleName] || 0;
}

function buildCacheKey(evidenceBundle = {}) {
  const marketId = evidenceBundle?.market?.marketId || 'unknown_market';
  const price = Number(evidenceBundle?.candidate?.price);
  const priceBucket = Number.isFinite(price) ? Math.round(price * 10) : 'na';
  const category = String(evidenceBundle?.market?.category || 'other').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  return `${marketId}_${priceBucket}_${category}`;
}

function buildRoleDecisions(roleOutputs = {}) {
  return Object.fromEntries(
    Object.entries(roleOutputs).map(([role, output]) => [role, {
      decision: output?.decision || output?.stance || null,
      side: output?.side || null,
      confidence: Number(output?.confidence || 0),
    }])
  );
}

function buildAgreementSnapshot(roleOutputs = {}) {
  const roleDecisions = buildRoleDecisions(roleOutputs);
  const entries = Object.entries(roleDecisions);
  const agrees = [];
  const disagrees = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [roleA, metaA] = entries[i];
      const [roleB, metaB] = entries[j];
      const valA = String(metaA?.decision || metaA?.side || '').toUpperCase();
      const valB = String(metaB?.decision || metaB?.side || '').toUpperCase();
      if (!valA || !valB) continue;
      if (valA === valB) agrees.push([roleA, roleB]);
      else disagrees.push([roleA, roleB]);
    }
  }
  return {
    roleDecisions,
    agreements: agrees,
    disagreements: disagrees,
    confidenceByRole: Object.fromEntries(entries.map(([role, meta]) => [role, meta.confidence || 0])),
  };
}

export function getCachedRole(roleName, cacheKey) {
  const ttlMs = getCacheTtl(roleName);
  if (!ttlMs) return null;
  const path = cacheFile(roleName, cacheKey);
  if (!existsSync(path)) return null;

  try {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    if (!cached?.ts || (Date.now() - new Date(cached.ts).getTime()) > ttlMs) return null;
    return cached.output || null;
  } catch {
    return null;
  }
}

export function setCachedRole(roleName, cacheKey, output) {
  const ttlMs = getCacheTtl(roleName);
  if (!ttlMs) return null;
  ensureDir();
  const path = cacheFile(roleName, cacheKey);
  writeFileSync(path, JSON.stringify({ ts: new Date().toISOString(), roleName, cacheKey, output }, null, 2));
  return path;
}

async function runRole(name, messages, validator, llmCallFn, runId, timing, roleOutputs, cacheKey = null) {
  const started = Date.now();
  const cachedOutput = cacheKey ? getCachedRole(name, cacheKey) : null;
  if (cachedOutput) {
    timing[name] = 0;
    roleOutputs[name] = {
      ...cachedOutput,
      cached: true,
    };
    ensureDir();
    writeFileSync(resolve(OUTPUT_DIR, `${runId}-${name}.json`), JSON.stringify({ messages, output: roleOutputs[name], cacheHit: true }, null, 2));
    return cachedOutput;
  }

  const rawText = await llmCallFn(messages);
  const validated = validator(rawText, name);
  timing[name] = Date.now() - started;
  roleOutputs[name] = {
    raw: parseMaybeJson(rawText),
    ...validated.cleaned,
    validationErrors: validated.errors,
    cached: false,
  };
  if (cacheKey) {
    setCachedRole(name, cacheKey, validated.cleaned);
  }
  ensureDir();
  writeFileSync(resolve(OUTPUT_DIR, `${runId}-${name}.json`), JSON.stringify({ messages, output: roleOutputs[name] }, null, 2));
  return validated.cleaned;
}

async function runRoleGroup(tasks) {
  const results = {};
  for (const task of tasks) {
    results[task.name] = await runRole(task.name, task.messages, task.validator, task.llmCallFn, task.runId, task.timing, task.roleOutputs, task.cacheKey || null);
  }
  return results;
}

function persistDecisionBundle({ runId, evidenceBundle, decision, finalProposal, roleOutputs, timing, startedAt, performanceSnapshot }) {
  ensureDir();
  const totalMs = Date.now() - startedAt;
  appendJsonl(DECISION_BUNDLES_PATH, {
    ts: new Date().toISOString(),
    runId,
    marketId: evidenceBundle?.market?.marketId || null,
    question: evidenceBundle?.market?.question || null,
    decision,
    finalProposal,
    roleOutputs: Object.fromEntries(Object.entries(roleOutputs || {}).map(([role, output]) => [role, summarizeRoleOutput(output)])),
    performanceSnapshot,
    timing: {
      total_ms: totalMs,
      ...timing,
    },
  });
}

export async function runTradingAgentsPipeline(evidenceBundle, opts = {}) {
  const { llmCallFn, memories = {}, l2Sim = null, ambiguityJudge = null } = opts;
  if (typeof llmCallFn !== 'function') throw new Error('runTradingAgentsPipeline requires opts.llmCallFn');

  const startedAt = Date.now();
  const runId = stamp();
  const timing = {};
  const roleOutputs = {};
  const analystReports = {};
  const riskSnapshot = evidenceBundle?.risk || {};
  const cacheKey = buildCacheKey(evidenceBundle);

  const bullMemories = formatMemories(memories.bull || memories.shared || retrieveMemories('bull_researcher', evidenceBundle, 3));
  const bearMemories = formatMemories(memories.bear || memories.shared || retrieveMemories('bear_researcher', evidenceBundle, 3));

  try {
    const splitAnalysts = await runRoleGroup([
      {
        name: 'social_analyst',
        messages: socialAnalystPrompt(evidenceBundle),
        validator: (text) => validateSocialAnalyst(text, 'social_analyst'),
        llmCallFn,
        runId,
        timing,
        roleOutputs,
        cacheKey,
      },
      {
        name: 'news_analyst',
        messages: newsAnalystPrompt(evidenceBundle),
        validator: (text) => validateNewsAnalyst(text, 'news_analyst'),
        llmCallFn,
        runId,
        timing,
        roleOutputs,
        cacheKey,
      },
    ]);
    analystReports.social = splitAnalysts.social_analyst;
    analystReports.news = splitAnalysts.news_analyst;
  } catch {
    analystReports.context = await runRole(
      'context_analyst',
      contextAnalystPrompt(evidenceBundle),
      (text) => validateAnalystReport(text, 'context_analyst'),
      llmCallFn,
      runId,
      timing,
      roleOutputs,
      cacheKey,
    );
    analystReports.social = analystReports.context;
    analystReports.news = analystReports.context;
  }

  analystReports.resolution = await runRole(
    'resolution_analyst',
    resolutionAnalystPrompt(evidenceBundle),
    (text) => validateAnalystReport(text, 'resolution_analyst'),
    llmCallFn,
    runId,
    timing,
    roleOutputs,
    cacheKey,
  );

  const bullCase = await runRole(
    'bull_researcher',
    bullResearcherPrompt(evidenceBundle, analystReports, bullMemories),
    (text) => validateResearchOutput(text, 'bull_researcher'),
    llmCallFn,
    runId,
    timing,
    roleOutputs,
  );

  const bearCase = await runRole(
    'bear_researcher',
    bearResearcherPrompt(evidenceBundle, analystReports, bullCase, bearMemories),
    (text) => validateResearchOutput(text, 'bear_researcher'),
    llmCallFn,
    runId,
    timing,
    roleOutputs,
  );

  const investmentPlan = await runRole(
    'research_manager',
    researchManagerPrompt(evidenceBundle, bullCase, bearCase, memories.manager || memories.shared || []),
    (text) => validateResearchOutput(text, 'research_manager'),
    llmCallFn,
    runId,
    timing,
    roleOutputs,
  );

  if (String(investmentPlan.decision || '').toUpperCase() === 'SKIP') {
    const performanceSnapshot = {
      ...buildAgreementSnapshot(roleOutputs),
      performanceSummary: getPerformanceSummary(),
    };
    const result = {
      decision: 'SKIP',
      reason: investmentPlan.summary || investmentPlan.thesis || 'research_manager_skip',
      finalProposal: null,
      roleOutputs,
      performanceSnapshot,
      timing: {
        ...timing,
        total_ms: Date.now() - startedAt,
      },
      runId,
    };
    persistDecisionBundle({ runId, evidenceBundle, decision: result.decision, finalProposal: result.finalProposal, roleOutputs, timing, startedAt, performanceSnapshot });
    return result;
  }

  const traderProposal = await runRole(
    'trader',
    traderPrompt(evidenceBundle, investmentPlan, riskSnapshot, l2Sim),
    (text) => validateTraderProposal(text),
    llmCallFn,
    runId,
    timing,
    roleOutputs,
  );

  let finalRisk;
  try {
    const splitRisk = await runRoleGroup([
      {
        name: 'aggressive_risk',
        messages: aggressiveRiskPrompt(evidenceBundle, traderProposal, analystReports, riskSnapshot),
        validator: (text) => validateAggressiveRisk(text, 'aggressive_risk'),
        llmCallFn,
        runId,
        timing,
        roleOutputs,
      },
      {
        name: 'conservative_risk',
        messages: conservativeRiskPrompt(evidenceBundle, traderProposal, analystReports, riskSnapshot),
        validator: (text) => validateConservativeRisk(text, 'conservative_risk'),
        llmCallFn,
        runId,
        timing,
        roleOutputs,
      },
    ]);

    const neutralCase = await runRole(
      'neutral_risk',
      neutralRiskPrompt(evidenceBundle, traderProposal, splitRisk.aggressive_risk, splitRisk.conservative_risk, riskSnapshot),
      (text) => validateNeutralRisk(text, 'neutral_risk'),
      llmCallFn,
      runId,
      timing,
      roleOutputs,
    );

    finalRisk = await runRole(
      'risk_manager_final',
      riskManagerFinalPrompt(evidenceBundle, traderProposal, splitRisk.aggressive_risk, splitRisk.conservative_risk, neutralCase, ambiguityJudge, riskSnapshot, l2Sim),
      (text) => validateRiskManagerFinal(text, 'risk_manager_final'),
      llmCallFn,
      runId,
      timing,
      roleOutputs,
    );
  } catch {
    finalRisk = await runRole(
      'risk_panel',
      riskPanelPrompt(evidenceBundle, traderProposal, analystReports, riskSnapshot),
      (text) => validateRiskOutput(text, 'risk_panel'),
      llmCallFn,
      runId,
      timing,
      roleOutputs,
    );
  }

  const finalProposal = {
    ...traderProposal,
    advisoryDecision: finalRisk.decision || 'REJECT',
    final_size_usd: finalRisk.final_size_usd || traderProposal.preferred_size_usd || 0,
    final_entry_cap: finalRisk.final_entry_cap || traderProposal.entry_band?.max || 0,
    top_edge: finalRisk.top_edge,
    top_risk: finalRisk.top_risk,
    must_not_trade_if: finalRisk.must_not_trade_if || [],
  };

  const performanceSnapshot = {
    ...buildAgreementSnapshot(roleOutputs),
    performanceSummary: getPerformanceSummary(),
  };

  const result = {
    decision: String(finalRisk.decision || 'REJECT').toUpperCase(),
    finalProposal,
    roleOutputs,
    performanceSnapshot,
    timing: {
      ...timing,
      total_ms: Date.now() - startedAt,
    },
    runId,
  };

  persistDecisionBundle({ runId, evidenceBundle, decision: result.decision, finalProposal, roleOutputs, timing, startedAt, performanceSnapshot });
  return result;
}

export default runTradingAgentsPipeline;

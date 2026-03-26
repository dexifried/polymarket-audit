#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import minimist from 'minimist';
import { SKILL_ROOT, loadEnvFallback } from '../lib/runtime.js';
import { fetchPolyglobeIntel } from '../lib/polyglobe.js';
import { retrieveAndRankContext } from '../lib/context_retrieval.js';

loadEnvFallback();

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = resolve(SKILL_ROOT, 'scripts');
const args = minimist(process.argv.slice(2));
const once = Boolean(args.once);
const intervalSec = Math.max(60, parseInt(args.interval || '300', 10) || 300);
const defaultModel = String(args.model || 'qwen-dex-sub:latest');
const escalationModel = String(args['escalation-model'] || 'qwen-dex-4b:latest');
const ollamaBase = String(args.host || 'http://100.65.179.80:11434');
const maxBreaking = Math.max(2, parseInt(args['max-breaking'] || '4', 10) || 4);

const execFileOpts = { maxBuffer: 1024 * 1024 * 4 };
const paperDir = resolve(SKILL_ROOT, 'memory', 'paper');
const accountPath = resolve(paperDir, 'account.json');
const transitionPath = resolve(paperDir, 'transition_model.json');
const watchdogLogPath = resolve(paperDir, 'qwen_watchdog.jsonl');
const watchdogLatestPath = resolve(paperDir, 'qwen_watchdog_latest.json');
const chillModePath = resolve(paperDir, 'chill_mode.json');

mkdirSync(paperDir, { recursive: true });

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendJsonl(path, obj) {
  appendFileSync(path, `${JSON.stringify(obj)}\n`);
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function compactText(text, limit = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function pickTopStates(transitionModel) {
  const stateCounts = transitionModel?.stateCounts || {};
  return Object.entries(stateCounts)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 4)
    .map(([label, count]) => ({ label, count }));
}

function categoryNeedsEscalation(category) {
  return ['geopolitics', 'macro', 'commodities', 'politics'].includes(String(category || '').toLowerCase());
}

function shouldEscalateModel(account, cleanedContextCache) {
  const openPositions = Array.isArray(account?.openPositions) ? account.openPositions : [];
  if (openPositions.some((position) => categoryNeedsEscalation(position.category) || position.resolutionRisk?.level === 'medium')) {
    return { escalate: true, reason: 'open_position_category_or_resolution_risk' };
  }

  const contextHasHardQuery = Array.isArray(cleanedContextCache?.queries)
    && cleanedContextCache.queries.some((query) => /(iran|israel|gaza|fed|ecb|crude oil|bitcoin|usd|rials|election|tariff|sanction)/i.test(query));
  if (contextHasHardQuery) {
    return { escalate: true, reason: 'context_query_complexity' };
  }

  return { escalate: false, reason: 'default_small_watchman' };
}

function buildContext(account, transitionModel, polyglobeIntel, cleanedContextCache) {
  const openPositions = Array.isArray(account?.openPositions) ? account.openPositions : [];
  const breakingMarkets = Array.isArray(polyglobeIntel?.breakingMarkets) ? polyglobeIntel.breakingMarkets.slice(0, maxBreaking) : [];

  return {
    generatedAt: nowIso(),
    account: {
      cashUsd: account?.cashUsd,
      realizedPnlUsd: account?.realizedPnlUsd,
      equityUsd: account?.risk?.equityUsd,
      paused: account?.risk?.paused,
      pauseReason: account?.risk?.pauseReason,
      drawdownUsd: account?.risk?.drawdownUsd,
      todayLossUsd: account?.risk?.todayLossUsd,
    },
    openPositions: openPositions.slice(0, 1).map((position) => ({
      question: compactText(position.question, 110),
      category: position.category || null,
      outcome: position.outcome || null,
      entryPrice: position.entryPrice,
      lastMarkPrice: position.lastMarkPrice,
      costUsd: position.costUsd,
      resolutionRiskLevel: position.resolutionRisk?.level || null,
      volatilityRiskFlags: position.volatilityRisk?.flags || [],
      rationale: position.rationale ? {
        spread: position.rationale.spread,
        imbalance: position.rationale.imbalance,
        score: position.rationale.score,
      } : null,
    })),
    breakingMarkets: breakingMarkets.map((item) => ({
      title: compactText(item.title, 100),
      latestPrice: item.latestPrice,
      priceMovement24h: item.priceMovement24h,
      volume24h: item.volume24h,
      locationCount: item.locationCount,
    })),
    cleanedContextMeta: cleanedContextCache ? {
      generatedAt: cleanedContextCache.generatedAt || null,
      methodUsed: cleanedContextCache.methodUsed || null,
      fallbackReason: cleanedContextCache.fallbackReason || null,
      queries: Array.isArray(cleanedContextCache.queries) ? cleanedContextCache.queries.slice(0, 2) : [],
    } : null,
    cleanedContext: Array.isArray(cleanedContextCache?.topContexts)
      ? cleanedContextCache.topContexts.slice(0, 2).map((item) => ({
          rank: item.rank,
          source: item.source,
          title: compactText(item.title, 100),
          matchedQuery: compactText(item.matchedQuery, 100),
          score: item.score,
          text: compactText(item.text, 120),
        }))
      : [],
    topStates: pickTopStates(transitionModel),
    freshnessMinutes: polyglobeIntel?.freshnessMinutes || {},
  };
}

function buildPrompt(context) {
  return [
    'You are a tiny watchdog model for a paper-only Polymarket system.',
    'Do not predict outcomes. Do not place trades. Only triage and flag risk.',
    'Be conservative. If uncertain, choose OBSERVE.',
    'Return STRICT JSON only. No markdown. No commentary. No trailing commas.',
    'Use this exact schema and keep arrays short (max 2 items each):',
    '{"overallVerdict":"ALLOW|OBSERVE|VETO","summary":"short string","riskFlags":["string"],"openPositionChecks":[{"question":"string","verdict":"HOLD|WATCH|REDUCE_RISK","confidence":0.0,"reason":"string"}],"breakingMarketChecks":[{"title":"string","verdict":"WATCH|IGNORE","confidence":0.0,"reason":"string"}]}',
    'If evidence is mixed, set overallVerdict to OBSERVE.',
    'Context JSON:',
    JSON.stringify(context),
  ].join('\n');
}

function extractBalancedJsonCandidate(text) {
  const source = String(text || '');
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (start === -1) {
      if (ch === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}

function salvageJson(text) {
  const source = String(text || '');
  const verdictMatch = source.match(/"?overallVerdict"?\s*:\s*"?(ALLOW|OBSERVE|VETO)"?/i);
  const summaryMatch = source.match(/"?summary"?\s*:\s*"([^\"]*)"/i);
  const riskFlagsSection = source.match(/"?riskFlags"?\s*:\s*\[([^\]]*)\]/i);
  const riskFlags = riskFlagsSection
    ? Array.from(riskFlagsSection[1].matchAll(/"([^\"]+)"/g)).map((m) => m[1]).slice(0, 6)
    : [];

  return {
    overallVerdict: verdictMatch ? verdictMatch[1].toUpperCase() : 'OBSERVE',
    summary: summaryMatch ? summaryMatch[1] : 'Recovered partial watchdog output from malformed JSON.',
    riskFlags,
    openPositionChecks: [],
    breakingMarketChecks: [],
    salvaged: true,
  };
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const balanced = extractBalancedJsonCandidate(trimmed);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {}
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }

  return salvageJson(trimmed);
}

async function invokeWatchdog(model, prompt) {
  const payload = {
    model,
    prompt,
    stream: false,
    think: false,
    format: 'json',
    options: {
      temperature: 0.1,
      top_p: 0.8,
      num_predict: 260,
    },
  };

  const { stdout } = await execFileAsync('curl', [
    '-sS',
    '--max-time', '45',
    `${ollamaBase}/api/generate`,
    '-d', JSON.stringify(payload),
  ], execFileOpts);

  const outer = JSON.parse(stdout);
  const candidateText = outer.response || outer.thinking || '';
  const parsed = extractJson(candidateText);
  return { parsed, raw: outer };
}

// Cerebras fallback for chill mode — skips local Ollama, uses cloud instead
async function invokeCerebras(context) {
  const cerebrasKey = process.env.CEREBRAS_KEY;
  if (!cerebrasKey) return { parsed: { overallVerdict: 'OBSERVE', summary: 'No Cerebras key', riskFlags: [] }, raw: {} };

  const systemPrompt = 'You are a watchdog for a paper-only Polymarket trading system. Analyze the context and return JSON only. Schema: {"overallVerdict":"ALLOW|OBSERVE|VETO","summary":"short string","riskFlags":["string"],"openPositionChecks":[],"breakingMarketChecks":[]}';

  const resp = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cerebrasKey}` },
    body: JSON.stringify({
      model: 'llama3.1-8b',
      temperature: 0.1,
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(context).slice(0, 3000) },
      ],
    }),
  });

  const json = await resp.json();
  const content = json?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = {}; }

  return {
    parsed: {
      overallVerdict: ['ALLOW', 'OBSERVE', 'VETO'].includes(parsed.overallVerdict) ? parsed.overallVerdict : 'OBSERVE',
      summary: parsed.summary || 'cerebras fallback',
      riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags : [],
      openPositionChecks: Array.isArray(parsed.openPositionChecks) ? parsed.openPositionChecks : [],
      breakingMarketChecks: Array.isArray(parsed.breakingMarketChecks) ? parsed.breakingMarketChecks : [],
    },
    raw: json,
    provider: 'cerebras',
  };
}

async function runOnce() {
  const account = readJson(accountPath, {});
  const transitionModel = readJson(transitionPath, {});
  const polyglobeIntel = await fetchPolyglobeIntel({ cacheTtlSec: 180 });
  const cleanedContextCache = await retrieveAndRankContext({ topK: 8 });
  const context = buildContext(account, transitionModel, polyglobeIntel, cleanedContextCache);
  const route = shouldEscalateModel(account, cleanedContextCache);
  const selectedModel = route.escalate ? escalationModel : defaultModel;

  // Check chill mode — skip local Ollama, use Cerebras cloud fallback
  const chillMode = readJson(chillModePath, { enabled: false });
  let parsed, raw, provider = 'local';

  if (chillMode.enabled) {
    const result = await invokeCerebras(context);
    parsed = result.parsed;
    raw = result.raw;
    provider = 'cerebras';
  } else {
    const result = await invokeWatchdog(selectedModel, buildPrompt(context));
    parsed = result.parsed;
    raw = result.raw;
  }

  const modelVerdict = ['ALLOW', 'OBSERVE', 'VETO'].includes(parsed.overallVerdict) ? parsed.overallVerdict : 'OBSERVE';
  const overallVerdict = account?.risk?.paused ? 'OBSERVE' : modelVerdict;
  const riskFlags = Array.isArray(parsed.riskFlags) ? parsed.riskFlags : [];
  if (account?.risk?.paused) riskFlags.unshift(`risk_engine_paused:${account.risk.pauseReason || 'unknown'}`);

  const record = {
    ts: nowIso(),
    model: chillMode.enabled ? 'cerebras-llama3.1-8b' : selectedModel,
    defaultModel,
    escalationModel,
    routeReason: chillMode.enabled ? 'chill-mode-cloud-fallback' : route.reason,
    host: chillMode.enabled ? 'api.cerebras.ai' : ollamaBase,
    provider,
    chillMode: chillMode.enabled,
    advisoryOnly: true,
    modelVerdict,
    overallVerdict,
    summary: parsed.summary || '',
    riskFlags,
    openPositionChecks: Array.isArray(parsed.openPositionChecks) ? parsed.openPositionChecks : [],
    breakingMarketChecks: Array.isArray(parsed.breakingMarketChecks) ? parsed.breakingMarketChecks : [],
    cleanedContextMeta: context.cleanedContextMeta,
    usage: {
      evalCount: raw.eval_count ?? null,
      promptEvalCount: raw.prompt_eval_count ?? null,
      totalDuration: raw.total_duration ?? null,
    },
  };

  appendJsonl(watchdogLogPath, record);
  writeJson(watchdogLatestPath, record);

  // Call Dex if VETO or significant risk flags
  if (overallVerdict === 'VETO' || riskFlags.length >= 3) {
    try {
      const { execFileSync } = await import('child_process');
      execFileSync('node', [resolve(SCRIPTS_DIR, 'call_dex.js'), `Watchdog ${overallVerdict}: ${riskFlags.join(', ') || parsed.summary || 'review needed'}`], { timeout: 10000, env: { ...process.env, CALLER: 'watchdog' } });
    } catch {}
  }

  console.log(JSON.stringify(record, null, 2));
}

async function main() {
  do {
    try {
      await runOnce();
    } catch (error) {
      const record = {
        ts: nowIso(),
        model: defaultModel,
        defaultModel,
        escalationModel,
        host: ollamaBase,
        advisoryOnly: true,
        overallVerdict: 'OBSERVE',
        summary: `Watchdog error: ${error.message}`,
        riskFlags: ['watchdog_error'],
        openPositionChecks: [],
        breakingMarketChecks: [],
      };
      appendJsonl(watchdogLogPath, record);
      writeJson(watchdogLatestPath, record);
      console.error(record.summary);
    }
    if (once) break;
    await sleep(intervalSec * 1000);
  } while (true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

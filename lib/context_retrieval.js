import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { SKILL_ROOT } from './runtime.js';

const PAPER_DIR = resolve(SKILL_ROOT, 'memory', 'paper');
const ACCOUNT_PATH = resolve(PAPER_DIR, 'account.json');
const POLYGLOBE_CACHE = resolve(PAPER_DIR, 'polyglobe_intel_cache.json');
const CONTEXT_CACHE = resolve(PAPER_DIR, 'qwen_context_cache.json');

function ensurePaperDir() {
  mkdirSync(PAPER_DIR, { recursive: true });
}

function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensurePaperDir();
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(text, limit = 320) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function tokenize(text) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length >= 3);
}

function scoreLexical(query, text) {
  const queryTokens = new Set(tokenize(query));
  const textTokens = new Set(tokenize(text));
  if (!queryTokens.size || !textTokens.size) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap += 1;
  }

  const denominator = Math.sqrt(queryTokens.size * textTokens.size);
  return denominator ? overlap / denominator : 0;
}

function buildQueries(account, polyglobeData) {
  const openPositions = Array.isArray(account?.openPositions) ? account.openPositions : [];
  const positionQueries = openPositions
    .map((position) => String(position.question || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  const fallbackBreaking = Array.isArray(polyglobeData?.breakingMarkets)
    ? polyglobeData.breakingMarkets.slice(0, 4).map((item) => String(item.title || '').trim()).filter(Boolean)
    : [];

  return [...new Set([...positionQueries, ...fallbackBreaking])].slice(0, 10);
}

function generateSnippets(polyglobeData, account) {
  const snippets = [];
  const seen = new Set();
  const addSnippet = (snippet) => {
    const text = compactText(snippet?.text || '', 420);
    if (!text) return;
    const key = `${snippet.source}:${snippet.id || text}`;
    if (seen.has(key)) return;
    seen.add(key);
    snippets.push({ ...snippet, text });
  };

  const openPositions = Array.isArray(account?.openPositions) ? account.openPositions : [];
  for (const position of openPositions) {
    addSnippet({
      id: position.id || position.tokenId || position.question,
      source: 'open_position',
      title: position.question || null,
      text: [
        position.question,
        `Outcome ${position.outcome || 'unknown'}`,
        `Entry ${position.entryPrice ?? 'n/a'}`,
        `Mark ${position.lastMarkPrice ?? 'n/a'}`,
        position.rationale ? `Rationale ${JSON.stringify(position.rationale)}` : '',
      ].filter(Boolean).join(' • '),
      metadata: {
        tokenId: position.tokenId || null,
        outcome: position.outcome || null,
        entryPrice: position.entryPrice ?? null,
        lastMarkPrice: position.lastMarkPrice ?? null,
      },
    });
  }

  const breakingMarkets = Array.isArray(polyglobeData?.breakingMarkets) ? polyglobeData.breakingMarkets : [];
  for (const market of breakingMarkets.slice(0, 30)) {
    addSnippet({
      id: market.marketId || market.slug || market.title,
      source: 'breaking_market',
      title: market.title || null,
      text: [
        market.title,
        market.description,
        `latest price ${market.latestPrice ?? 'n/a'}`,
        `24h move ${market.priceMovement24h ?? 'n/a'}`,
        `volume ${market.volume24h ?? 'n/a'}`,
      ].filter(Boolean).join(' • '),
      metadata: {
        latestPrice: market.latestPrice ?? null,
        priceMovement24h: market.priceMovement24h ?? null,
        volume24h: market.volume24h ?? null,
        locationCount: market.locationCount ?? null,
      },
    });
  }

  const tweets = Array.isArray(polyglobeData?.osintExtended?.tweets) ? polyglobeData.osintExtended.tweets : [];
  for (const item of tweets.slice(0, 60)) {
    addSnippet({
      id: item.id || item.url || item.timestamp,
      source: 'osint_tweet',
      title: item.handle ? `@${item.handle}` : 'tweet',
      text: [
        item.handle ? `@${item.handle}` : '',
        item.text,
        item.hasMatch ? `matched ${item.matchQuality ?? 'n/a'}` : '',
        item.isAlert ? 'alert' : '',
        item.isGeotagged ? 'geotagged' : '',
      ].filter(Boolean).join(' • '),
      metadata: {
        handle: item.handle || null,
        timestamp: item.timestamp || null,
        hasMatch: Boolean(item.hasMatch),
        matchQuality: item.matchQuality ?? null,
        isAlert: Boolean(item.isAlert),
        isGeotagged: Boolean(item.isGeotagged),
      },
    });
  }

  const truth = Array.isArray(polyglobeData?.osintExtended?.truth) ? polyglobeData.osintExtended.truth : [];
  for (const item of truth.slice(0, 30)) {
    addSnippet({
      id: item.id || item.url || item.timestamp,
      source: 'osint_truth',
      title: item.handle ? `@${item.handle}` : 'truth',
      text: [item.handle ? `@${item.handle}` : '', item.text].filter(Boolean).join(' • '),
      metadata: {
        handle: item.handle || null,
        timestamp: item.timestamp || null,
      },
    });
  }

  return snippets;
}

async function fetchDeepInfraEmbeddings(inputs, apiKey) {
  const res = await fetch('https://api.deepinfra.com/v1/openai/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'BAAI/bge-large-en-v1.5',
      input: inputs,
      encoding_format: 'float',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepInfra embeddings failed (${res.status}): ${text.slice(0, 240)}`);
  }

  const json = await res.json();
  return Array.isArray(json?.data) ? json.data.map((row) => row.embedding) : [];
}

function dot(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) sum += Number(a[i] || 0) * Number(b[i] || 0);
  return sum;
}

function magnitude(a) {
  return Math.sqrt(a.reduce((sum, value) => sum + Number(value || 0) * Number(value || 0), 0));
}

function cosine(a, b) {
  const denom = magnitude(a) * magnitude(b);
  return denom ? dot(a, b) / denom : 0;
}

async function scoreWithDeepInfra(snippets, queries, apiKey) {
  const embeddings = await fetchDeepInfraEmbeddings([
    ...queries.map((query) => `query: ${query}`),
    ...snippets.map((snippet) => `passage: ${snippet.text}`),
  ], apiKey);

  const queryEmbeddings = embeddings.slice(0, queries.length);
  const snippetEmbeddings = embeddings.slice(queries.length);

  return snippets.map((snippet, index) => {
    const perQuery = queries.map((query, queryIndex) => ({
      query,
      score: cosine(queryEmbeddings[queryIndex] || [], snippetEmbeddings[index] || []),
    })).sort((a, b) => b.score - a.score);

    return {
      ...snippet,
      score: perQuery[0]?.score ?? 0,
      matchedQuery: perQuery[0]?.query ?? null,
      queryScores: perQuery.slice(0, 3),
    };
  }).sort((a, b) => b.score - a.score);
}

function scoreWithFallback(snippets, queries) {
  return snippets.map((snippet) => {
    const perQuery = queries.map((query) => ({
      query,
      score: scoreLexical(query, snippet.text),
    })).sort((a, b) => b.score - a.score);

    return {
      ...snippet,
      score: perQuery[0]?.score ?? 0,
      matchedQuery: perQuery[0]?.query ?? null,
      queryScores: perQuery.slice(0, 3),
    };
  }).sort((a, b) => b.score - a.score);
}

export async function retrieveAndRankContext({ deepInfraKey = process.env.DEEPINFRA_API_KEY, topK = 12 } = {}) {
  const account = readJson(ACCOUNT_PATH, {});
  const polyglobeData = readJson(POLYGLOBE_CACHE, {});
  const queries = buildQueries(account, polyglobeData);
  const snippets = generateSnippets(polyglobeData, account);

  let methodUsed = 'fallback';
  let fallbackReason = null;
  let ranked = [];

  if (!queries.length || !snippets.length) {
    const emptyCache = {
      generatedAt: nowIso(),
      methodUsed,
      fallbackReason: !queries.length ? 'no_queries' : 'no_snippets',
      queryCount: queries.length,
      snippetCount: snippets.length,
      queries,
      topContexts: [],
    };
    writeJson(CONTEXT_CACHE, emptyCache);
    return emptyCache;
  }

  if (deepInfraKey) {
    try {
      ranked = await scoreWithDeepInfra(snippets, queries, deepInfraKey);
      methodUsed = 'deepinfra';
    } catch (error) {
      fallbackReason = error.message;
      ranked = scoreWithFallback(snippets, queries);
    }
  } else {
    fallbackReason = 'missing_DEEPINFRA_API_KEY';
    ranked = scoreWithFallback(snippets, queries);
  }

  const cache = {
    generatedAt: nowIso(),
    methodUsed,
    fallbackReason,
    queryCount: queries.length,
    snippetCount: snippets.length,
    queries,
    topContexts: ranked.slice(0, topK).map((item, index) => ({
      rank: index + 1,
      source: item.source,
      title: item.title || null,
      text: item.text,
      score: Number(item.score?.toFixed ? item.score.toFixed(4) : item.score) || 0,
      matchedQuery: item.matchedQuery || null,
      queryScores: (item.queryScores || []).map((entry) => ({
        query: entry.query,
        score: Number(entry.score?.toFixed ? entry.score.toFixed(4) : entry.score) || 0,
      })),
      metadata: item.metadata || {},
    })),
  };

  writeJson(CONTEXT_CACHE, cache);
  return cache;
}

export function getContextCachePath() {
  return CONTEXT_CACHE;
}

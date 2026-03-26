import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { SKILL_ROOT } from './runtime.js';
import { loadProfiles, getNetworkSummary, classifyTopic } from './agent_profiles.js';
import { loadAndCluster, findBestThemes, detectRegimeShift } from './market_clusters.js';

const DEFAULT_ATOMIC_FACTS_PATH = resolve(SKILL_ROOT, 'memory', 'paper', 'atomic_facts.jsonl');
const DEFAULT_FORESIGHTS_PATH = resolve(SKILL_ROOT, 'memory', 'paper', 'foresights.jsonl');
const DEFAULT_PROFILES_PATH = resolve(SKILL_ROOT, 'memory', 'paper', 'agent_profiles.json');
const DEFAULT_CLUSTERS_PATH = existsSync(resolve(SKILL_ROOT, 'memory', 'paper', 'regime_states.jsonl'))
  ? resolve(SKILL_ROOT, 'memory', 'paper', 'regime_states.jsonl')
  : resolve(SKILL_ROOT, 'memory', 'paper', 'decisions.jsonl');
const DEFAULT_EMBED_ENDPOINT = 'https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Embedding-8B';
const DEFAULT_SOURCES = ['atomic_facts', 'foresights'];
const RRF_K = 60;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function uniqueTokens(value) {
  return [...new Set(tokenize(value))];
}

function safeParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readJsonlFile(filePath) {
  const resolvedPath = resolve(SKILL_ROOT, filePath);
  if (!existsSync(resolvedPath)) return [];

  try {
    let malformedCount = 0;
    const rows = readFileSync(resolvedPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parsed = safeParseJson(line);
        if (!parsed) malformedCount += 1;
        return parsed;
      })
      .filter(Boolean);
    if (malformedCount > 0) console.warn(`[retrieval] ${malformedCount} malformed JSONL rows`);
    return rows;
  } catch {
    return [];
  }
}

function scoreKeywordMatch(query, text) {
  const queryWords = uniqueTokens(query);
  if (!queryWords.length) return 0;

  const textWords = new Set(uniqueTokens(text));
  let matched = 0;
  for (const word of queryWords) {
    if (textWords.has(word)) matched += 1;
  }

  return matched / queryWords.length;
}

function buildAtomicFactSearchRows(entries = []) {
  const rows = [];
  for (const entry of entries) {
    const atomicFacts = Array.isArray(entry?.atomic_facts) ? entry.atomic_facts : [];
    for (let i = 0; i < atomicFacts.length; i += 1) {
      const factText = String(atomicFacts[i] || '').trim();
      if (!factText) continue;
      rows.push({
        source: 'atomic_facts',
        text: factText,
        data: {
          ...entry,
          factIndex: i,
          matchedFact: factText,
        },
      });
    }
  }
  return rows;
}

function buildForesightSearchRows(entries = []) {
  const rows = [];
  for (const entry of entries) {
    const foresights = Array.isArray(entry?.foresights) ? entry.foresights : [];
    for (let i = 0; i < foresights.length; i += 1) {
      const foresight = foresights[i] || {};
      const parts = [
        entry?.question,
        foresight?.content,
        foresight?.evidence,
        foresight?.catalyst_type,
      ].filter(Boolean);
      const text = parts.join(' | ').trim();
      if (!text) continue;
      rows.push({
        source: 'foresights',
        text,
        data: {
          ...entry,
          foresightIndex: i,
          matchedForesight: foresight,
        },
      });
    }
  }
  return rows;
}

function loadSearchRows(sources = DEFAULT_SOURCES) {
  const enabledSources = Array.isArray(sources) && sources.length ? sources : DEFAULT_SOURCES;
  const rows = [];

  if (enabledSources.includes('atomic_facts')) {
    rows.push(...buildAtomicFactSearchRows(readJsonlFile(DEFAULT_ATOMIC_FACTS_PATH)));
  }

  if (enabledSources.includes('foresights')) {
    rows.push(...buildForesightSearchRows(readJsonlFile(DEFAULT_FORESIGHTS_PATH)));
  }

  return rows;
}

function extractEmbeddings(payload) {
  if (Array.isArray(payload?.embeddings)) return payload.embeddings;
  if (Array.isArray(payload?.data)) {
    return payload.data.map((item) => item?.embedding).filter(Array.isArray);
  }
  if (Array.isArray(payload)) return payload.filter(Array.isArray);
  if (Array.isArray(payload?.results)) {
    return payload.results.map((item) => item?.embedding).filter(Array.isArray);
  }
  return [];
}

async function embedQuery(query) {
  const apiKey = process.env.DEEPINFRA_API_KEY;
  const endpoint = process.env.DEEPINFRA_EMBED_ENDPOINT || DEFAULT_EMBED_ENDPOINT;
  if (!apiKey) {
    throw new Error('DEEPINFRA_API_KEY not set');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ inputs: [query] }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Embedding request failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const payload = await response.json();
    const embeddings = extractEmbeddings(payload);
    const embedding = embeddings[0];
    if (!Array.isArray(embedding) || !embedding.length) {
      throw new Error('No embedding returned for query');
    }

    return embedding;
  } finally {
    clearTimeout(timeout);
  }
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;

  const size = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < size; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function similarityKey(result) {
  return normalizeText(result?.text || '');
}

function dedupeSimilarResults(results = []) {
  const seen = new Map();

  for (const result of results) {
    const key = similarityKey(result);
    if (!key) continue;

    const existing = seen.get(key);
    const currentScore = Number(result?.rrfScore ?? result?.similarity ?? result?.score ?? 0);
    const existingScore = Number(existing?.rrfScore ?? existing?.similarity ?? existing?.score ?? 0);

    if (!existing || currentScore > existingScore) {
      seen.set(key, result);
    }
  }

  return [...seen.values()];
}

function buildAtomicFactVectorRows(entries = []) {
  const rows = [];
  for (const entry of entries) {
    const atomicFacts = Array.isArray(entry?.atomic_facts) ? entry.atomic_facts : [];
    const embeddings = Array.isArray(entry?.fact_embeddings) ? entry.fact_embeddings : [];
    for (let i = 0; i < atomicFacts.length; i += 1) {
      const text = String(atomicFacts[i] || '').trim();
      const embedding = embeddings[i];
      if (!text || !Array.isArray(embedding) || !embedding.length) continue;
      rows.push({
        source: 'atomic_facts',
        text,
        embedding,
        data: {
          ...entry,
          factIndex: i,
          matchedFact: text,
        },
      });
    }
  }
  return rows;
}

export async function keywordSearch(query, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 10;
  const sources = Array.isArray(options.sources) && options.sources.length ? options.sources : DEFAULT_SOURCES;
  const rows = loadSearchRows(sources);

  const results = rows
    .map((row) => ({
      ...row,
      score: scoreKeywordMatch(query, row.text),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
    .slice(0, limit)
    .map(({ source, text, score, data }) => ({ source, text, score, data }));

  return {
    results,
    count: results.length,
  };
}

export async function vectorSearch(query, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 10;
  const sources = Array.isArray(options.sources) && options.sources.length ? options.sources : DEFAULT_SOURCES;

  if (!sources.includes('atomic_facts')) {
    return { results: [], count: 0, method: 'vector' };
  }

  try {
    const queryEmbedding = await embedQuery(query);
    const entries = readJsonlFile(DEFAULT_ATOMIC_FACTS_PATH);
    const rows = buildAtomicFactVectorRows(entries);

    const results = rows
      .map((row) => ({
        source: row.source,
        text: row.text,
        similarity: cosineSimilarity(queryEmbedding, row.embedding),
        data: row.data,
      }))
      .filter((row) => row.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return {
      results,
      count: results.length,
      method: 'vector',
    };
  } catch {
    const fallback = await keywordSearch(query, { ...options, sources: sources.includes('atomic_facts') ? ['atomic_facts'] : sources });
    return {
      results: fallback.results.map((item) => ({
        source: item.source,
        text: item.text,
        similarity: item.score,
        data: item.data,
      })),
      count: fallback.count,
      method: 'keyword-fallback',
    };
  }
}

export async function hybridSearch(query, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 10;
  const sources = Array.isArray(options.sources) && options.sources.length ? options.sources : DEFAULT_SOURCES;

  const [keyword, vector] = await Promise.all([
    keywordSearch(query, { ...options, sources, limit: Math.max(limit * 2, limit) }),
    vectorSearch(query, { ...options, sources, limit: Math.max(limit * 2, limit) }),
  ]);

  const merged = new Map();

  keyword.results.forEach((result, index) => {
    const key = similarityKey(result);
    if (!key) return;
    const rank = index + 1;
    const current = merged.get(key) || {
      source: result.source,
      text: result.text,
      data: result.data,
      rrfScore: 0,
      keywordRank: null,
      vectorRank: null,
    };
    current.rrfScore += 1 / (RRF_K + rank);
    current.keywordRank = rank;
    merged.set(key, current);
  });

  vector.results.forEach((result, index) => {
    const key = similarityKey(result);
    if (!key) return;
    const rank = index + 1;
    const current = merged.get(key) || {
      source: result.source,
      text: result.text,
      data: result.data,
      rrfScore: 0,
      keywordRank: null,
      vectorRank: null,
    };
    current.rrfScore += 1 / (RRF_K + rank);
    current.vectorRank = rank;
    if (!current.data) current.data = result.data;
    merged.set(key, current);
  });

  const results = dedupeSimilarResults([...merged.values()])
    .sort((a, b) => b.rrfScore - a.rrfScore || (a.keywordRank ?? Infinity) - (b.keywordRank ?? Infinity))
    .slice(0, limit)
    .map((item) => ({
      source: item.source,
      text: item.text,
      rrfScore: item.rrfScore,
      keywordRank: item.keywordRank,
      vectorRank: item.vectorRank,
      data: item.data,
    }));

  return {
    results,
    count: results.length,
    method: 'hybrid',
  };
}

export async function search(query, options = {}) {
  const method = options.method || 'hybrid';
  const normalizedOptions = {
    limit: Number.isFinite(Number(options.limit)) ? Number(options.limit) : 10,
    sources: Array.isArray(options.sources) && options.sources.length ? options.sources : DEFAULT_SOURCES,
  };

  if (method === 'keyword') return keywordSearch(query, normalizedOptions);
  if (method === 'vector') return vectorSearch(query, normalizedOptions);
  return hybridSearch(query, normalizedOptions);
}

function getCategoryFromPosition(position = {}) {
  return String(position?.category || classifyTopic(position?.question || '') || 'other').toLowerCase();
}

function rankCategoryAgents(profiles = {}, category = 'other') {
  return Object.values(profiles || {})
    .map((profile) => {
      const topicStats = profile?.topicPerformance?.[category] || {};
      return {
        agent: profile?.agent || 'unknown',
        role: profile?.role || 'unknown',
        totalDecisions: profile?.totalDecisions || 0,
        overallWinRate: profile?.winRate || 0,
        avgPnl: profile?.avgPnl || 0,
        category,
        categoryStats: topicStats,
      };
    })
    .sort((a, b) => {
      const aw = Number(a.categoryStats?.winRate || 0);
      const bw = Number(b.categoryStats?.winRate || 0);
      if (bw !== aw) return bw - aw;
      const as = Number(a.categoryStats?.wins || 0) + Number(a.categoryStats?.losses || 0);
      const bs = Number(b.categoryStats?.wins || 0) + Number(b.categoryStats?.losses || 0);
      return bs - as;
    });
}

function findRelevantCluster(clusters = [], category = 'other') {
  return (Array.isArray(clusters) ? clusters : []).find((cluster) => String(cluster?.category || '').toLowerCase() === category) || null;
}

export async function getContextForPosition(position = {}) {
  const category = getCategoryFromPosition(position);
  const query = [position?.question, category].filter(Boolean).join(' ');

  const [similarTrades, relevantForesights, clusterData] = await Promise.all([
    keywordSearch(query, { sources: ['atomic_facts'], limit: 5 }),
    keywordSearch(query, { sources: ['foresights'], limit: 5 }),
    loadAndCluster(DEFAULT_CLUSTERS_PATH),
  ]);

  const profiles = loadProfiles(DEFAULT_PROFILES_PATH);
  const bestThemes = findBestThemes(clusterData?.clusters || []).slice(0, 5);
  const currentCluster = findRelevantCluster(clusterData?.clusters || [], category);
  const previousComparable = (clusterData?.clusters || []).find((cluster) => cluster !== currentCluster) || null;

  return {
    similarTrades: similarTrades.results,
    relevantForesights: relevantForesights.results,
    agentPerformance: {
      category,
      networkSummary: getNetworkSummary(profiles),
      topAgentsForCategory: rankCategoryAgents(profiles, category).slice(0, 5),
    },
    clusterContext: {
      regime: clusterData?.regime || { overall: 'quiet', byCategory: {} },
      currentCluster,
      bestThemes,
      regimeShift: currentCluster && previousComparable ? detectRegimeShift(currentCluster, previousComparable) : {
        shifted: false,
        category,
        changes: [],
        severity: 'low',
      },
    },
    queryTime: new Date().toISOString(),
  };
}

export default {
  keywordSearch,
  vectorSearch,
  hybridSearch,
  search,
  getContextForPosition,
  cosineSimilarity,
};

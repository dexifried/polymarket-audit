import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { SKILL_ROOT } from './runtime.js';

const CACHE_PATH = resolve(SKILL_ROOT, 'memory', 'paper', 'polyglobe_intel_cache.json');
const DEFAULT_TTL_SEC = 180;

const ENDPOINTS = {
  breaking: 'https://www.pizzint.watch/api/markets/breaking?window=6h',
  osintHead: 'https://www.pizzint.watch/api/osint-feed/head?includeTruth=1',
  osintExtended: 'https://www.pizzint.watch/api/osint-feed?includeTruth=1&includeMedia=1&limit=80&truthLimit=80',
  clusters: 'https://www.pizzint.watch/api/markets/clusters',
  slugs: 'https://www.pizzint.watch/api/markets/slugs',
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function ensureCacheDir() {
  mkdirSync(resolve(SKILL_ROOT, 'memory', 'paper'), { recursive: true });
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    ensureCacheDir();
    writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch {
    // Ignore cache write failures; collector can still return fresh data.
  }
}

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'dex-polyglobe-collector/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBreakingMarket(market) {
  return {
    marketId: String(market.market_id || market.id || ''),
    title: market.title || null,
    titleKey: normalizeText(market.title),
    slug: market.slug || null,
    latestPrice: Number.isFinite(Number(market.latest_price)) ? Number(market.latest_price) : null,
    priceMovement24h: Number.isFinite(Number(market.price_movement)) ? Number(market.price_movement) : null,
    volume24h: Number.isFinite(Number(market.volume_24h)) ? Number(market.volume_24h) : null,
    clobTokenIds: Array.isArray(market.clob_token_ids) ? market.clob_token_ids.map(String) : [],
    locationCount: Array.isArray(market.locations) ? market.locations.length : 0,
    embedUrl: market.embed_url || null,
    description: market.description || null,
  };
}

function normalizeOsintItem(item) {
  return {
    id: String(item.id || item.url || item.timestamp || ''),
    handle: item.handle || null,
    text: item.text || item.title || '',
    url: item.url || null,
    timestamp: item.timestamp || null,
    hasMatch: Boolean(item.hasMatch),
    matchQuality: Number.isFinite(Number(item.matchQuality)) ? Number(item.matchQuality) : null,
    isGeotagged: Boolean(item.isGeotagged),
    isAlert: Boolean(item.isAlert),
    media: Array.isArray(item.media) ? item.media.slice(0, 4) : [],
  };
}

function buildQuestionIndex(breakingMarkets) {
  return Object.fromEntries(
    breakingMarkets
      .filter((market) => market.titleKey)
      .map((market) => [market.titleKey, market])
  );
}

function minutesSince(timestamp) {
  if (!timestamp) return null;
  const deltaMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(deltaMs)) return null;
  return Math.round((deltaMs / 60000) * 100) / 100;
}

export async function fetchPolyglobeIntel({ cacheTtlSec = DEFAULT_TTL_SEC, forceRefresh = false } = {}) {
  const cached = loadCache();
  if (!forceRefresh && cached?.fetchedAt) {
    const ageSec = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
    if (ageSec < cacheTtlSec) return { ...cached, cacheHit: true };
  }

  try {
    const [breakingRaw, osintHeadRaw] = await Promise.all([
      fetchJson(ENDPOINTS.breaking),
      fetchJson(ENDPOINTS.osintHead),
    ]);

    const breakingMarkets = Array.isArray(breakingRaw?.markets)
      ? breakingRaw.markets.map(normalizeBreakingMarket)
      : [];

    const [osintExtendedRaw, clustersRaw, slugsRaw] = await Promise.all([
      fetchJson(ENDPOINTS.osintExtended),
      fetchJson(ENDPOINTS.clusters),
      fetchJson(ENDPOINTS.slugs),
    ]);

    const intel = {
      fetchedAt: nowIso(),
      cacheHit: false,
      breakingMarkets,
      questionIndex: buildQuestionIndex(breakingMarkets),
      osintHead: osintHeadRaw || null,
      osintExtended: {
        tweets: Array.isArray(osintExtendedRaw?.tweets) ? osintExtendedRaw.tweets.map(normalizeOsintItem) : [],
        truth: Array.isArray(osintExtendedRaw?.truth) ? osintExtendedRaw.truth.map(normalizeOsintItem) : [],
      },
      clusters: Array.isArray(clustersRaw?.features) ? clustersRaw.features.slice(0, 500) : [],
      slugs: Array.isArray(slugsRaw) ? slugsRaw.slice(0, 500) : [],
      freshnessMinutes: {
        latestMatchedTweet: minutesSince(osintHeadRaw?.latestMatchedTweetTimestamp),
        latestGeotag: minutesSince(osintHeadRaw?.latestGeotagTimestamp),
        latestTruth: minutesSince(osintHeadRaw?.latestTruthTimestamp),
      },
    };

    saveCache(intel);
    return intel;
  } catch (error) {
    if (cached) {
      return {
        ...cached,
        cacheHit: true,
        stale: true,
        error: error.message,
      };
    }
    return {
      fetchedAt: nowIso(),
      cacheHit: false,
      stale: false,
      error: error.message,
      breakingMarkets: [],
      questionIndex: {},
      osintHead: null,
      freshnessMinutes: {},
    };
  }
}

export function matchPolyglobeIntel(market, intel) {
  if (!market || !intel) return null;
  const questionKey = normalizeText(market.question);
  const tokenIds = Array.isArray(market.tokens)
    ? market.tokens.map((token) => String(token.token_id || token.tokenId || '')).filter(Boolean)
    : [];

  let matched = intel.questionIndex?.[questionKey] || null;
  if (!matched && tokenIds.length) {
    matched = intel.breakingMarkets.find((entry) => entry.clobTokenIds.some((id) => tokenIds.includes(id))) || null;
  }
  if (!matched) return null;

  return {
    isBreaking: true,
    marketId: matched.marketId,
    title: matched.title,
    latestPrice: matched.latestPrice,
    priceMovement24h: matched.priceMovement24h,
    volume24h: matched.volume24h,
    locationCount: matched.locationCount,
    embedUrl: matched.embedUrl,
    freshnessMinutes: intel.freshnessMinutes || {},
  };
}

export function getPolyglobeCachePath() {
  return CACHE_PATH;
}

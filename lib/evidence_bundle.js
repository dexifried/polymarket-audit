import { matchPolyglobeIntel } from './polyglobe.js';

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function obj(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeContextSnippets(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item.text === 'string') return item.text.trim();
      return '';
    })
    .filter(Boolean)
    .slice(0, 8);
}

function findManifoldRef(candidate, state = {}) {
  if (candidate?.manifoldEdge) return candidate.manifoldEdge;
  const refs = arr(state.manifoldRefs);
  const question = String(candidate?.market?.question || '').toLowerCase();
  return refs.find((ref) => String(ref?.question || ref?.title || '').toLowerCase() === question) || refs[0] || null;
}

function normalizePolyglobe(candidate, state = {}) {
  const market = candidate?.market || {};
  const intel = state?.polyglobeIntel || null;
  const matched = candidate?.polyglobe || matchPolyglobeIntel(market, intel);
  const tweets = [
    ...arr(intel?.osintExtended?.tweets),
    ...arr(intel?.osintExtended?.truth),
  ]
    .filter((item) => {
      const text = String(item?.text || '').toLowerCase();
      const q = String(market?.question || '').toLowerCase();
      if (!text) return false;
      if (!q) return true;
      return q.split(/\s+/).filter((w) => w.length > 3).some((w) => text.includes(w));
    })
    .slice(0, 6)
    .map((item) => ({
      id: item?.id || null,
      handle: item?.handle || null,
      text: item?.text || '',
      url: item?.url || null,
      timestamp: item?.timestamp || null,
    }));

  return {
    matched: Boolean(matched),
    marketId: matched?.marketId || null,
    title: matched?.title || null,
    tweets,
    freshness: matched?.freshnessMinutes || intel?.freshnessMinutes || null,
    latestPrice: num(matched?.latestPrice, null),
    priceMovement24h: num(matched?.priceMovement24h, null),
    volume24h: num(matched?.volume24h, null),
  };
}

function normalizeManifold(candidate, state = {}) {
  const ref = findManifoldRef(candidate, state);
  const edge = candidate?.manifoldEdge || ref || null;
  if (!edge) return null;
  return {
    question: edge?.manifoldQuestion || edge?.question || edge?.title || null,
    price: num(edge?.manifoldProb ?? edge?.probability, null),
    edge: num(edge?.gap ?? edge?.edge, null),
    volume: num(edge?.manifoldVolume ?? edge?.volume, null),
    polyPrice: num(edge?.polyPrice, null),
  };
}

function normalizeBinance(opts = {}) {
  const data = obj(opts.binanceData);
  if (!Object.keys(data).length) return null;
  return {
    price: num(data.price ?? data.last ?? data.current, null),
    return5s: num(data.return5s ?? data.returns?.[5], null),
    return15s: num(data.return15s ?? data.returns?.[15], null),
    return30s: num(data.return30s ?? data.returns?.[30], null),
    vol30s: num(data.vol30s ?? data.volatility ?? data.realizedVol, null),
    updatedAt: data.updatedAt || null,
  };
}

export function buildEvidenceBundle(candidate, state = {}, opts = {}) {
  const market = candidate?.market || {};
  const token = candidate?.token || {};
  const risk = obj(state.risk);
  const account = obj(state.account, state);
  const category = market?.groupItemTitle || market?.category || candidate?.category || 'other';

  return {
    market: {
      marketId: market?.condition_id || market?.marketId || market?.id || null,
      question: market?.question || null,
      endDate: market?.end_date_iso || market?.endDate || null,
      description: market?.description || market?.rules || null,
      tags: arr(market?.tags).map((tag) => (typeof tag === 'string' ? tag : tag?.label || tag?.name)).filter(Boolean),
      category,
      slug: market?.slug || null,
    },
    candidate: {
      tokenId: token?.token_id || token?.tokenId || null,
      outcome: token?.outcome || null,
      price: num(token?.price, null),
      spread: num(candidate?.spread, null),
      bidDepth: num(candidate?.bidDepth, null),
      askDepth: num(candidate?.askDepth, null),
      imbalance: num(candidate?.imbalance, null),
      imbalanceZ: num(candidate?.imbalanceZ ?? candidate?.features?.imbalanceZ, null),
      score: num(candidate?.score, null),
      isAmm: Boolean(candidate?.isAmm),
      amMGap: num(candidate?.ammGap ?? candidate?.amMGap, 0),
      bestBid: num(candidate?.bestBid, null),
      bestAsk: num(candidate?.bestAsk, null),
    },
    external: {
      polyglobe: normalizePolyglobe(candidate, state),
      manifold: normalizeManifold(candidate, state),
      binance: normalizeBinance(opts),
      contexts: normalizeContextSnippets(opts.contextSnippets),
    },
    risk: {
      paused: Boolean(risk?.paused),
      equityUsd: num(risk?.equityUsd ?? account?.equityUsd, null),
      drawdownUsd: num(risk?.drawdownUsd, null),
      todayLossUsd: num(risk?.todayLossUsd, null),
      consecutiveLosses: num(risk?.consecutiveLosses, 0),
      openPositions: arr(account?.openPositions).length,
      maxPositions: num(account?.maxPositions ?? state?.maxPositions, null),
      categoryExposure: obj(account?.categoryExposure, {}),
      reserveUsd: num(risk?.reserveUsd, null),
      cashUsd: num(account?.cashUsd, null),
    },
    memory: opts.memoryContext || null,  // Enriched by memory_retrieval.getContextForPosition
  };
}

export async function enrichWithMemory(bundle) {
  try {
    const { getContextForPosition } = await import('./memory_retrieval.js');
    const position = {
      tokenId: bundle.candidate.tokenId,
      question: bundle.market.question,
      outcome: bundle.candidate.outcome,
      entryPrice: bundle.candidate.price,
      category: bundle.market.category,
    };
    const ctx = await getContextForPosition(position);

    // Slim down memory context to avoid LLM token overflow
    // Only pass compact summaries, not full data objects
    return {
      ...bundle,
      memory: {
        similarTradeCount: ctx.similarTrades?.length || 0,
        topSimilarFacts: (ctx.similarTrades || []).slice(0, 3).map(r => r.text?.slice(0, 120)),
        foresightCount: ctx.relevantForesights?.length || 0,
        topForesights: (ctx.relevantForesights || []).slice(0, 3).map(r => r.text?.slice(0, 120)),
        regime: ctx.clusterContext?.regime?.overall || 'unknown',
        bestTheme: ctx.clusterContext?.bestThemes?.[0]?.category || 'none',
        topAgent: ctx.agentPerformance?.topAgentsForCategory?.[0]?.agent || 'none',
      },
    };
  } catch {
    return bundle;
  }
}

export default buildEvidenceBundle;

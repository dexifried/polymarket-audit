import { appendFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT_PATH = resolve(SKILL_ROOT, 'memory', 'paper', 'foresights.jsonl');
const DEFAULT_DEEPINFRA_ENDPOINT = 'https://api.deepinfra.com/v1/openai/chat/completions';
const DEFAULT_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct';
const DEFAULT_TIMEOUT_MS = 15_000;

function safeDate(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}

function isoDay(value) {
  return safeDate(value).toISOString().slice(0, 10);
}

function addDays(value, days = 0) {
  const date = safeDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function diffDays(start, end) {
  const startDate = safeDate(start);
  const endDate = safeDate(end);
  const ms = endDate.getTime() - startDate.getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}

function clampWordy(text, maxWords = 40) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function pickCategory(position, context) {
  return String(context?.category || position?.category || 'general').toLowerCase();
}

function numeric(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function summarizeContext(context) {
  const relatedCount = Array.isArray(context?.relatedMarkets) ? context.relatedMarkets.length : 0;
  const binance = context?.binanceData && typeof context.binanceData === 'object' ? context.binanceData : null;
  const polyglobe = context?.polyglobe && typeof context.polyglobe === 'object' ? context.polyglobe : null;
  return {
    category: context?.category || null,
    relatedMarkets: relatedCount ? context.relatedMarkets.slice(0, 5) : [],
    binanceData: binance,
    polyglobe,
  };
}

function makeForesight(fields = {}) {
  const start = fields.start_time || isoDay(new Date());
  const end = fields.end_time || start;
  return {
    content: clampWordy(fields.content || 'Watch for a market-moving catalyst.'),
    evidence: String(fields.evidence || 'Generated from trade metadata and category heuristics.'),
    catalyst_type: fields.catalyst_type || 'news',
    start_time: start,
    end_time: end,
    duration_days: numeric(fields.duration_days, diffDays(start, end)),
    confidence: ['high', 'medium', 'low'].includes(fields.confidence) ? fields.confidence : 'medium',
  };
}

function ensureGenericForesights(foresights, position, openedAt) {
  const generic = [
    makeForesight({
      content: `Market sentiment shift could reprice ${position?.question || 'this market'} even without a hard resolution update.`,
      evidence: `Prediction markets often move on positioning, liquidity, and narrative swings around an open price of ${position?.entryPrice ?? 'unknown'}.`,
      catalyst_type: 'sentiment',
      start_time: isoDay(openedAt),
      end_time: addDays(openedAt, 14),
      duration_days: 14,
      confidence: 'medium',
    }),
    makeForesight({
      content: `A fresh news catalyst could quickly change probability for ${position?.question || 'this market'}.`,
      evidence: 'Headline risk and primary-source updates routinely move thin prediction markets before final resolution.',
      catalyst_type: 'news',
      start_time: isoDay(openedAt),
      end_time: addDays(openedAt, 21),
      duration_days: 21,
      confidence: 'medium',
    }),
  ];

  const existingTypes = new Set(foresights.map((item) => item.catalyst_type));
  for (const item of generic) {
    if (!existingTypes.has(item.catalyst_type)) foresights.push(item);
  }
  return foresights;
}

function cryptoForesights(position, context, openedAt) {
  const question = position?.question || 'this crypto market';
  const entryPrice = numeric(position?.entryPrice, null);
  const currentPrice = numeric(context?.binanceData?.btc || context?.binanceData?.BTCUSDT || context?.binanceData?.price, null);
  const resistance = currentPrice ? Math.round(currentPrice * 1.05 / 1000) * 1000 : 95_000;
  const support = currentPrice ? Math.round(currentPrice * 0.95 / 1000) * 1000 : 85_000;
  return [
    makeForesight({
      content: `The next FOMC decision could create a sharp crypto volatility window that reprices ${question}.`,
      evidence: 'Rate decisions and Powell guidance often spill into BTC and broad risk assets within hours.',
      catalyst_type: 'macro',
      start_time: addDays(openedAt, 12),
      end_time: addDays(openedAt, 13),
      duration_days: 1,
      confidence: 'high',
    }),
    makeForesight({
      content: `ETF flow or regulatory headlines could move probability away from the ${Math.round((entryPrice ?? 0.5) * 100)}% entry anchor.`,
      evidence: 'Spot ETF inflow/outflow streaks and SEC-related headlines frequently reshape near-term crypto sentiment.',
      catalyst_type: 'regulatory',
      start_time: addDays(openedAt, 4),
      end_time: addDays(openedAt, 7),
      duration_days: 3,
      confidence: 'medium',
    }),
    makeForesight({
      content: `If BTC clears ${resistance.toLocaleString()}, traders may chase upside and lift the Yes probability; failure there is the contrarian risk.`,
      evidence: `Technical breakouts around visible resistance/support often drive prediction-market repricing before fundamentals catch up. Support sits near ${support.toLocaleString()}.`,
      catalyst_type: 'technical',
      start_time: isoDay(openedAt),
      end_time: addDays(openedAt, 30),
      duration_days: 30,
      confidence: 'medium',
    }),
    makeForesight({
      content: 'Halving-cycle or miner-supply narratives could revive momentum if broader crypto flows strengthen.',
      evidence: 'Macro cycle narratives can re-enter quickly when price trends and on-chain positioning align.',
      catalyst_type: 'scheduled',
      start_time: addDays(openedAt, 7),
      end_time: addDays(openedAt, 45),
      duration_days: 38,
      confidence: 'low',
    }),
  ];
}

function politicsForesights(position, context, openedAt) {
  const question = position?.question || 'this political market';
  return [
    makeForesight({
      content: `A new polling release could shift expectations for ${question}.`,
      evidence: 'High-quality polls often move event contracts before any official campaign development lands.',
      catalyst_type: 'scheduled',
      start_time: addDays(openedAt, 3),
      end_time: addDays(openedAt, 6),
      duration_days: 3,
      confidence: 'high',
    }),
    makeForesight({
      content: 'Debate scheduling, candidate appearances, or viral clips may create fast narrative repricing.',
      evidence: 'Political markets react quickly to attention shocks, especially in low-liquidity periods.',
      catalyst_type: 'news',
      start_time: addDays(openedAt, 7),
      end_time: addDays(openedAt, 14),
      duration_days: 7,
      confidence: 'medium',
    }),
    makeForesight({
      content: 'Filing deadlines, ballot challenges, or legal rulings are the main contrarian risk to consensus positioning.',
      evidence: 'Procedural changes can matter more than campaign vibes for resolution-linked political contracts.',
      catalyst_type: 'regulatory',
      start_time: addDays(openedAt, 10),
      end_time: addDays(openedAt, 20),
      duration_days: 10,
      confidence: 'medium',
    }),
  ];
}

function sportsForesights(position, context, openedAt) {
  const question = position?.question || 'this sports market';
  return [
    makeForesight({
      content: `Injury reports or lineup confirmations could meaningfully move ${question}.`,
      evidence: 'Availability news is often the single biggest short-term driver in sports pricing.',
      catalyst_type: 'news',
      start_time: addDays(openedAt, 1),
      end_time: addDays(openedAt, 4),
      duration_days: 3,
      confidence: 'high',
    }),
    makeForesight({
      content: 'Schedule reveals, travel spots, or rest advantages may reshape perceived edge before game time.',
      evidence: 'Sports contracts often drift when matchup context becomes clearer.',
      catalyst_type: 'scheduled',
      start_time: addDays(openedAt, 2),
      end_time: addDays(openedAt, 10),
      duration_days: 8,
      confidence: 'medium',
    }),
    makeForesight({
      content: 'Playoff qualification or elimination scenarios create the main contrarian risk if standings change unexpectedly.',
      evidence: 'Adjacent game results can reprice futures faster than team-specific news alone.',
      catalyst_type: 'sentiment',
      start_time: addDays(openedAt, 5),
      end_time: addDays(openedAt, 21),
      duration_days: 16,
      confidence: 'medium',
    }),
  ];
}

function conflictForesights(position, context, openedAt) {
  const question = position?.question || 'this conflict market';
  return [
    makeForesight({
      content: `UN statements, Security Council activity, or allied diplomatic pressure could reprice ${question}.`,
      evidence: 'Formal diplomatic actions can shift both sentiment and resolution expectations quickly.',
      catalyst_type: 'regulatory',
      start_time: addDays(openedAt, 2),
      end_time: addDays(openedAt, 9),
      duration_days: 7,
      confidence: 'medium',
    }),
    makeForesight({
      content: 'Ceasefire talks, prisoner swaps, or back-channel negotiations may create sudden downside for escalation bets.',
      evidence: 'Conflict markets react sharply to negotiation headlines, even before terms are finalized.',
      catalyst_type: 'news',
      start_time: addDays(openedAt, 1),
      end_time: addDays(openedAt, 14),
      duration_days: 13,
      confidence: 'high',
    }),
    makeForesight({
      content: 'A fresh military strike or cross-border escalation remains the clearest contrarian trigger if diplomacy stalls.',
      evidence: 'Escalation events usually dominate previous narrative drift and cause immediate repricing.',
      catalyst_type: 'scheduled',
      start_time: isoDay(openedAt),
      end_time: addDays(openedAt, 21),
      duration_days: 21,
      confidence: 'medium',
    }),
  ];
}

function genericCategoryForesights(position, context, openedAt) {
  const category = pickCategory(position, context);
  return [
    makeForesight({
      content: `Watch for category-specific headlines or primary-source updates that could move this ${category} market.`,
      evidence: 'Prediction markets often move before resolution when credible new information emerges.',
      catalyst_type: 'news',
      start_time: isoDay(openedAt),
      end_time: addDays(openedAt, 14),
      duration_days: 14,
      confidence: 'medium',
    }),
    makeForesight({
      content: `Related markets in ${category} may spill over into this contract if sentiment broadens or reverses.`,
      evidence: `There are ${Array.isArray(context?.relatedMarkets) ? context.relatedMarkets.length : 0} related tracked markets in context.`,
      catalyst_type: 'sentiment',
      start_time: isoDay(openedAt),
      end_time: addDays(openedAt, 21),
      duration_days: 21,
      confidence: 'low',
    }),
  ];
}

function normalizeLLMArray(payload, position, openedAt) {
  if (!Array.isArray(payload)) return null;
  const cleaned = payload
    .filter((item) => item && typeof item === 'object')
    .map((item) => makeForesight({
      content: item.content,
      evidence: item.evidence,
      catalyst_type: item.catalyst_type,
      start_time: item.start_time || isoDay(openedAt),
      end_time: item.end_time || item.start_time || addDays(openedAt, 1),
      duration_days: item.duration_days,
      confidence: item.confidence,
    }))
    .slice(0, 6);

  if (!cleaned.length) return null;
  return ensureGenericForesights(cleaned, position, openedAt).slice(0, 6);
}

function extractJSONArray(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    const start = value.indexOf('[');
    const end = value.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(value.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function buildLLMPrompt(position, context) {
  const question = position?.question || 'Unknown market';
  const outcome = position?.outcome || 'Unknown side';
  const entryPrice = position?.entryPrice ?? 'unknown';
  const category = pickCategory(position, context);
  const score = position?.score ?? 'unknown';
  const spread = position?.spread ?? 'unknown';
  const imbalance = position?.imbalance ?? 'unknown';
  const openedAt = position?.openedAt || new Date().toISOString();
  const contextData = JSON.stringify(summarizeContext(context), null, 2);

  return `You are a prediction market foresight analyst. A trader just opened a position.\n\nPOSITION:\n- Market: ${question}\n- Side: ${outcome} at $${entryPrice}\n- Category: ${category}\n- Score: ${score} | Spread: ${spread} | Imbalance: ${imbalance}\n- Opened: ${openedAt}\n\nCONTEXT:\n${contextData}\n\nGenerate 3-6 specific future catalysts/events that could move this market's probability.\nFor each catalyst, estimate when it might happen and how confident you are.\n\nReturn ONLY a JSON array:\n[\n  {\n    \"content\": \"Specific prediction about what could happen\",\n    \"evidence\": \"Why this matters for the position\",\n    \"catalyst_type\": \"regulatory|macro|technical|news|scheduled|sentiment\",\n    \"start_time\": \"YYYY-MM-DD\",\n    \"end_time\": \"YYYY-MM-DD\",\n    \"duration_days\": N,\n    \"confidence\": \"high|medium|low\"\n  }\n]\n\nRules:\n- Be specific with dates when possible (FOMC dates, election dates, etc.)\n- Focus on ACTUAL catalysts, not vague \"price might go up\"\n- Include at least one contrarian risk (what could make the position lose)\n- Each prediction ≤40 words\n- Return ONLY the JSON array, no explanation`;
}

export function generateForesightFromRules(position = {}, context = {}) {
  const openedAt = safeDate(position?.openedAt);
  const category = pickCategory(position, context);
  let foresights;

  switch (category) {
    case 'crypto':
      foresights = cryptoForesights(position, context, openedAt);
      break;
    case 'politics':
    case 'political':
      foresights = politicsForesights(position, context, openedAt);
      break;
    case 'sports':
      foresights = sportsForesights(position, context, openedAt);
      break;
    case 'conflict':
    case 'geopolitics':
    case 'war':
      foresights = conflictForesights(position, context, openedAt);
      break;
    default:
      foresights = genericCategoryForesights(position, context, openedAt);
      break;
  }

  const finalForesights = ensureGenericForesights(foresights, position, openedAt).slice(0, 6);
  return {
    tokenId: position?.tokenId || null,
    question: position?.question || null,
    generatedAt: new Date().toISOString(),
    source: 'rules',
    foresights: finalForesights,
  };
}

export async function generateForesightFromLLM(position = {}, context = {}) {
  const fallback = generateForesightFromRules(position, context);
  const endpoint = process.env.DEEPINFRA_CHAT_ENDPOINT || DEFAULT_DEEPINFRA_ENDPOINT;
  const apiKey = process.env.DEEPINFRA_API_KEY;
  const openedAt = safeDate(position?.openedAt);

  if (!apiKey) {
    return {
      ...fallback,
      source: 'rules-fallback',
      llmError: 'DEEPINFRA_API_KEY not set',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        temperature: 0.3,
        max_tokens: 700,
        response_format: { type: 'text' },
        messages: [
          {
            role: 'user',
            content: buildLLMPrompt(position, context),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`DeepInfra request failed with ${response.status}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
    const parsed = extractJSONArray(text);
    const normalized = normalizeLLMArray(parsed, position, openedAt);
    if (!normalized) {
      throw new Error('LLM returned invalid foresight JSON');
    }

    return {
      tokenId: position?.tokenId || null,
      question: position?.question || null,
      generatedAt: new Date().toISOString(),
      source: 'llm',
      foresights: normalized,
    };
  } catch (error) {
    return {
      ...fallback,
      source: 'rules-fallback',
      llmError: error?.name === 'AbortError' ? 'LLM request timed out' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateForesight(position = {}, context = {}) {
  return generateForesightFromLLM(position, context);
}

export async function persistForesight(foresightObj, filePath = DEFAULT_OUTPUT_PATH) {
  const targetPath = resolve(filePath);
  await mkdir(dirname(targetPath), { recursive: true });
  const line = `${JSON.stringify(foresightObj)}\n`;
  await appendFile(targetPath, line, 'utf8');
  return targetPath;
}

function overlap(startA, endA, startB, endB) {
  const a1 = safeDate(startA).getTime();
  const a2 = safeDate(endA || startA).getTime();
  const b1 = safeDate(startB).getTime();
  const b2 = safeDate(endB || startB).getTime();
  return a1 <= b2 && b1 <= a2;
}

export function checkForesightOutcomes(foresightObj = {}, exitData = {}) {
  const generatedAt = foresightObj?.generatedAt || new Date().toISOString();
  const holdStart = exitData?.openedAt || exitData?.entryTime || foresightObj?.openedAt || generatedAt;
  const holdEnd = exitData?.closedAt || exitData?.exitTime || exitData?.soldAt || new Date().toISOString();
  const foresights = Array.isArray(foresightObj?.foresights) ? foresightObj.foresights : [];

  const triggered = [];
  const missed = [];

  for (const item of foresights) {
    if (overlap(item?.start_time, item?.end_time, holdStart, holdEnd)) triggered.push(item);
    else missed.push(item);
  }

  const accuracy = foresights.length ? triggered.length / foresights.length : 0;
  return { triggered, missed, accuracy };
}

export async function processNewPosition(position = {}, context = {}, outputPath = DEFAULT_OUTPUT_PATH) {
  const foresightObj = await generateForesight(position, context);
  const enriched = {
    ...foresightObj,
    tokenId: foresightObj.tokenId || position?.tokenId || null,
    question: foresightObj.question || position?.question || null,
    openedAt: position?.openedAt || null,
    category: pickCategory(position, context),
  };
  await persistForesight(enriched, outputPath);
  return enriched;
}

export default {
  generateForesight,
  generateForesightFromLLM,
  generateForesightFromRules,
  persistForesight,
  checkForesightOutcomes,
  processNewPosition,
};

import { appendFileSync } from 'fs';
import { normalizeMidpointResponse } from './runtime.js';

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round(n, d) { return Math.round((n + Number.EPSILON) * (10**d)) / (10**d); }

let monitorState = null;
let closePositionHandler = null;
const closingPositions = new Set();

export function initPositionMonitor(state, closePositionFn) {
  monitorState = state;
  closePositionHandler = closePositionFn;
}

function appendJsonl(filePath, obj) {
  if (!filePath) return;
  appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

async function markPosition(position, client) {
  try {
    const raw = await client.getMidpoint(position.tokenId);
    if (raw && typeof raw === 'object' && raw.error) return position.lastMarkPrice ?? position.entryPrice;
    const mid = Number(normalizeMidpointResponse(raw));
    return Number.isFinite(mid) && mid > 0 ? mid : (position.lastMarkPrice ?? position.entryPrice);
  } catch {
    return position.lastMarkPrice ?? position.entryPrice;
  }
}

export async function checkPositions(state = monitorState, marketData = {}) {
  if (!state || !closePositionHandler) return [];

  const {
    client,
    takeProfitPct = state?.strategy?.takeProfitPct ?? 0.1,
    stopLossPct = state?.strategy?.stopLossPct ?? 0.05,
    maxHoldHours = state?.strategy?.maxHoldHours ?? 3,
    decisionsPath = null,
  } = marketData;

  if (!client) return [];

  const exitEvents = [];
  for (const position of [...(state.openPositions || [])]) {
    const positionKey = String(position.positionId || position.id || position.orderId || position.tokenId);
    if (closingPositions.has(positionKey)) continue;
    const currentPrice = Number(await markPosition(position, client));
    position.lastMarkPrice = currentPrice;
    position.highWaterPrice = Math.max(position.highWaterPrice || position.entryPrice, currentPrice);

    const heldMs = Date.now() - new Date(position.openedAt).getTime();
    const heldMinutes = heldMs / 60000;
    const heldHours = heldMs / 3600000;
    const entry = Number(position.entryPrice);
    const pnl = Number((position.shares * currentPrice) - position.costUsd);

    let reason = null;
    if (currentPrice >= entry * (1 + takeProfitPct)) {
      reason = 'take-profit';
    } else if (currentPrice <= entry * (1 - stopLossPct) && heldMinutes >= 2) {
      reason = 'stop-loss';
    } else if (position.highWaterPrice >= entry * 1.05 && currentPrice <= position.highWaterPrice * (1 - stopLossPct)) {
      reason = 'trailing-stop';
    } else if (heldMinutes >= 30 && currentPrice < entry * 0.97) {
      reason = 'early-exit-downtrend';
    } else if (heldHours >= maxHoldHours) {
      reason = 'time-exit';
    } else if (marketData.dexReview?.positionAdvice?.find((a) => a.question === position.question && a.action === 'EXIT')) {
      reason = 'dex-advisory-exit';
    }

    if (reason) {
      // Apply realistic exit slippage — selling on thin markets moves price down
      const tradeUsd = position.shares * currentPrice;
      const exitImpactPct = 0.01 + (tradeUsd / 10) * 0.025; // same model as entry
      const gasCostBps = tradeUsd > 0 ? (0.01 / tradeUsd) * 10000 : 0;
      const adjustedExitPrice = currentPrice * (1 - (exitImpactPct + gasCostBps / 10000));
      const finalExitPrice = Math.max(0, adjustedExitPrice);
      const adjustedPnl = (position.shares * finalExitPrice) - position.costUsd;
      console.log(`[EXIT] ${String(position.question || '').slice(0,40)} | ${reason} | mid=${currentPrice} exit=${round(finalExitPrice, 4)} impact=${Math.round(exitImpactPct * 10000)}bps pnl=${Math.round((adjustedPnl + Number.EPSILON) * 100) / 100}`);
      closingPositions.add(positionKey);
      try {
        await closePositionHandler(state, position, finalExitPrice, reason);
      } finally {
        closingPositions.delete(positionKey);
      }
      exitEvents.push({
        tokenId: position.tokenId,
        question: position.question,
        reason,
        entryPrice: entry,
        exitPrice: currentPrice,
        pnl,
      });
    } else {
      // MARK log — proves position is being price-checked every cycle
      appendJsonl(decisionsPath, {
        ts: new Date().toISOString(),
        type: 'MARK',
        tokenId: position.tokenId,
        question: position.question,
        outcome: position.outcome,
        entryPrice: entry,
        markPrice: currentPrice,
        highWaterPrice: position.highWaterPrice,
        unrealizedPnlUsd: Math.round((pnl + Number.EPSILON) * 100) / 100,
        heldMinutes: Math.round(heldMinutes),
        tpTrigger: round2(entry * (1 + takeProfitPct)),
        slTrigger: round2(entry * (1 - stopLossPct)),
        trailingTrigger: position.highWaterPrice >= entry * 1.05 ? round2(position.highWaterPrice * (1 - stopLossPct)) : null,
      });
      appendJsonl(decisionsPath, {
        ts: new Date().toISOString(),
        type: 'HOLD',
        tokenId: position.tokenId,
        question: position.question,
        outcome: position.outcome,
        markPrice: currentPrice,
        unrealizedPnlUsd: Math.round((pnl + Number.EPSILON) * 100) / 100,
        note: 'Position monitor safety-net hold',
      });
    }
  }

  return exitEvents;
}

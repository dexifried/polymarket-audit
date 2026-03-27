const round = (value, digits = 6) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** digits;
  return Math.round((numeric + Number.EPSILON) * factor) / factor;
};

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => {
      if (Array.isArray(level)) {
        return [Number(level[0]), Number(level[1])];
      }
      if (level && typeof level === 'object') {
        return [Number(level.price), Number(level.size)];
      }
      return [NaN, NaN];
    })
    .filter(([price, size]) => Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0);
}

function walkLevels(levels, targetUsd) {
  let remainingUsd = Number(targetUsd);
  let filledUsd = 0;
  let filledShares = 0;

  for (const [price, size] of levels) {
    if (remainingUsd <= 1e-9) break;
    const levelUsd = price * size;
    if (!(levelUsd > 0)) continue;
    const takeUsd = Math.min(remainingUsd, levelUsd);
    const takeShares = takeUsd / price;
    filledUsd += takeUsd;
    filledShares += takeShares;
    remainingUsd -= takeUsd;
  }

  const avgFillPrice = filledShares > 0 ? filledUsd / filledShares : null;
  return {
    avgFillPrice,
    filledUsd,
    unfilledUsd: Math.max(0, remainingUsd),
    fillRatio: targetUsd > 0 ? filledUsd / targetUsd : 0,
  };
}

export function simulateL2Fill(decision, snapshot) {
  const action = String(decision?.action || '').toUpperCase();
  const sizeUsd = Number(decision?.size_usd);
  const maxSlippageBps = Number(decision?.max_slippage_bps);
  const bids = normalizeLevels(snapshot?.bids);
  const asks = normalizeLevels(snapshot?.asks);

  const bookSide = action === 'SELL' ? bids : asks;
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return {
      avg_fill_price: null,
      filled_usd: 0,
      unfilled_usd: 0,
      slippage_bps: null,
      fill_ratio: 0,
      status: 'no_depth',
    };
  }

  if (!bookSide.length) {
    return {
      avg_fill_price: null,
      filled_usd: 0,
      unfilled_usd: round(sizeUsd, 6),
      slippage_bps: null,
      fill_ratio: 0,
      status: 'no_depth',
    };
  }

  const topPrice = bookSide[0][0];
  const walked = walkLevels(bookSide, sizeUsd);
  const avgFillPrice = walked.avgFillPrice;

  if (!Number.isFinite(avgFillPrice) || !Number.isFinite(topPrice) || topPrice <= 0) {
    return {
      avg_fill_price: null,
      filled_usd: 0,
      unfilled_usd: round(sizeUsd, 6),
      slippage_bps: null,
      fill_ratio: 0,
      status: 'no_depth',
    };
  }

  const rawSlippage = action === 'SELL'
    ? ((topPrice - avgFillPrice) / topPrice) * 10000
    : ((avgFillPrice - topPrice) / topPrice) * 10000;
  const slippageBps = Math.max(0, rawSlippage);

  // --- Realistic Polymarket execution costs ---
  // Polymarket CLOB: 0% taker fee
  // Real costs: orderbook walk slippage + $0.01 Polygon gas per trade
  const GAS_COST_USD = 0.01;  // Polygon network fee per trade
  // Slippage depends on how much of the book we eat
  // No artificial minimum — let the real orderbook walk speak
  const gasPenaltyBps = sizeUsd > 0 ? (GAS_COST_USD / sizeUsd) * 10000 : 0;
  // Partial fills eat more levels = more slippage (this comes naturally from walkLevels)
  // Small orders (<$2) on thin markets can have high proportional gas cost

  const totalCostBps = slippageBps + gasPenaltyBps;

  // Apply costs to fill price (buying: price goes up; selling: price goes down)
  const adjustedFillPrice = action === 'SELL'
    ? avgFillPrice * (1 - totalCostBps / 10000)
    : avgFillPrice * (1 + totalCostBps / 10000);

  const base = {
    avg_fill_price: round(adjustedFillPrice, 6),
    filled_usd: round(walked.filledUsd, 6),
    unfilled_usd: round(walked.unfilledUsd, 6),
    slippage_bps: round(slippageBps, 4),
    gas_bps: round(gasPenaltyBps, 4),
    fill_ratio: round(walked.fillRatio, 6),
    status: walked.unfilledUsd > 1e-9 ? 'partial' : 'filled',
  };

  if (Number.isFinite(maxSlippageBps) && slippageBps > maxSlippageBps) {
    return {
      ...base,
      avg_fill_price: null,
      filled_usd: 0,
      fill_ratio: 0,
      unfilled_usd: round(sizeUsd, 6),
      status: 'rejected_slippage',
    };
  }

  return base;
}

export default simulateL2Fill;

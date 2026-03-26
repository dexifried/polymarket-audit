function clamp(min, max, value) {
  return Math.min(max, Math.max(min, value));
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function computeFairValue(params) {
  const currentSpotPrice = numberOr(params?.currentSpotPrice, null);
  const windowOpenPrice = numberOr(params?.windowOpenPrice, null);
  const timeRemainingSec = numberOr(params?.timeRemainingSec, null);
  const realizedVol = numberOr(params?.realizedVol, 0.0005);
  const pmYesPrice = numberOr(params?.pmYesPrice, null);
  const pmNoPrice = numberOr(params?.pmNoPrice, pmYesPrice != null ? 1 - pmYesPrice : null);
  const shortReturnBps = numberOr(params?.shortReturnBps, 0);

  if (!Number.isFinite(currentSpotPrice) || !Number.isFinite(windowOpenPrice) || windowOpenPrice <= 0 || !Number.isFinite(timeRemainingSec)) {
    throw new Error('computeFairValue requires currentSpotPrice, windowOpenPrice, and timeRemainingSec');
  }

  const displacement = (currentSpotPrice - windowOpenPrice) / windowOpenPrice;
  const timePressure = clamp(0, 1, 1 - (timeRemainingSec / 900));
  const volatilityPenalty = clamp(0, 0.2, realizedVol * 10);

  const momentumBoost = clamp(-0.2, 0.2, (shortReturnBps / 10000) * 8);
  const modelA = clamp(0.01, 0.99, 0.5 + (displacement * 10) + momentumBoost);

  const scale = 18 + (timePressure * 32);
  const modelB = clamp(0.01, 0.99, (displacement * scale) + 0.5);

  const reversalDrag = clamp(-0.15, 0.15, realizedVol * Math.sqrt(Math.max(timeRemainingSec, 1) / 60) * 4);
  const direction = Math.sign(displacement || shortReturnBps || 0);
  const modelC = clamp(0.01, 0.99, modelB + (direction * -reversalDrag) - volatilityPenalty + 0.02);

  const fairYes = clamp(
    0.01,
    0.99,
    (modelA * 0.35) + (modelB * 0.4) + (modelC * 0.25),
  );
  const fairNo = clamp(0.01, 0.99, 1 - fairYes);

  const edgeYesBps = Number.isFinite(pmYesPrice) ? (fairYes - pmYesPrice) * 10000 : null;
  const edgeNoBps = Number.isFinite(pmNoPrice) ? (fairNo - pmNoPrice) * 10000 : null;

  let model = 'late_window';
  if (Math.abs(shortReturnBps) >= 15) model = 'momentum_burst';
  else if (timeRemainingSec <= 120) model = 'late_window';
  else if (realizedVol > 0.002) model = 'vol_adjusted';

  const confidence = clamp(
    0.05,
    0.99,
    0.35 + (Math.min(Math.abs(displacement) * 120, 0.3)) + (timePressure * 0.25) - Math.min(realizedVol * 8, 0.2),
  );

  return {
    fairYes,
    fairNo,
    edgeYesBps,
    edgeNoBps,
    model,
    confidence,
    diagnostics: {
      displacement,
      shortReturnBps,
      timePressure,
      realizedVol,
      modelA,
      modelB,
      modelC,
    },
  };
}

export default computeFairValue;

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker';
const MAX_HISTORY_MS = 5 * 60 * 1000;
const RETURN_WINDOWS = [5, 15, 30, 60];
const ASSET_TO_SYMBOL = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
};
const SYMBOL_TO_ASSET = Object.fromEntries(Object.entries(ASSET_TO_SYMBOL).map(([asset, symbol]) => [symbol, asset]));

function clampNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function computeReturnBps(current, reference) {
  if (!Number.isFinite(current) || !Number.isFinite(reference) || reference <= 0) return null;
  return ((current - reference) / reference) * 10000;
}

function realizedVolatility(samples, lookbackMs = 60_000) {
  const cutoff = Date.now() - lookbackMs;
  const relevant = samples.filter((sample) => sample.ts >= cutoff);
  if (relevant.length < 2) return null;

  const returns = [];
  for (let i = 1; i < relevant.length; i += 1) {
    const prev = relevant[i - 1].price;
    const next = relevant[i].price;
    if (prev > 0 && next > 0) returns.push(Math.log(next / prev));
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
  return Math.sqrt(Math.max(variance, 0));
}

function createAssetState() {
  return {
    price: null,
    returns: new Map(),
    volatility: null,
    history: [],
    updatedAt: null,
  };
}

export function createBinanceFeed({ assets = ['BTC', 'ETH'], signal } = {}) {
  const enabledAssets = assets.filter((asset) => ASSET_TO_SYMBOL[asset]);
  const state = new Map(enabledAssets.map((asset) => [asset, createAssetState()]));
  let ws = null;
  let connected = false;
  let reconnectDelayMs = 1_000;
  let reconnectTimer = null;
  let manuallyStopped = false;
  let activeController = null;

  function cleanupSocket() {
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch {}
      ws = null;
    }
    connected = false;
  }

  function scheduleReconnect() {
    if (manuallyStopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  }

  function refreshMetrics(asset) {
    const assetState = state.get(asset);
    if (!assetState || !Number.isFinite(assetState.price)) return;
    const now = Date.now();
    assetState.history = assetState.history.filter((sample) => (now - sample.ts) <= MAX_HISTORY_MS);

    for (const seconds of RETURN_WINDOWS) {
      const cutoff = now - (seconds * 1000);
      const reference = [...assetState.history].reverse().find((sample) => sample.ts <= cutoff)?.price ?? assetState.history[0]?.price;
      assetState.returns.set(seconds, computeReturnBps(assetState.price, reference));
    }

    assetState.volatility = realizedVolatility(assetState.history, 60_000);
  }

  function handleMessage(rawMessage) {
    let payload;
    try {
      payload = JSON.parse(rawMessage.data);
    } catch {
      return;
    }

    const message = payload?.data ?? payload;
    const symbol = String(message?.s || '').toUpperCase();
    const asset = SYMBOL_TO_ASSET[symbol];
    if (!asset || !state.has(asset)) return;

    const price = clampNumber(message?.c);
    if (!Number.isFinite(price)) return;

    const ts = clampNumber(message?.E, Date.now());
    const assetState = state.get(asset);
    assetState.price = price;
    assetState.updatedAt = ts;
    assetState.history.push({ ts, price });
    refreshMetrics(asset);
  }

  function connect() {
    if (manuallyStopped) return;
    cleanupSocket();
    activeController = new AbortController();
    ws = new WebSocket(BINANCE_WS_URL);

    ws.onopen = () => {
      connected = true;
      reconnectDelayMs = 1_000;
    };
    ws.onmessage = handleMessage;
    ws.onerror = () => {
      connected = false;
    };
    ws.onclose = () => {
      connected = false;
      cleanupSocket();
      scheduleReconnect();
    };

    activeController.signal.addEventListener('abort', () => {
      manuallyStopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanupSocket();
    }, { once: true });
  }

  if (signal) {
    signal.addEventListener('abort', () => {
      manuallyStopped = true;
      if (activeController) activeController.abort();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanupSocket();
    }, { once: true });
  }

  connect();

  return {
    getPrice(asset) {
      return state.get(asset)?.price ?? null;
    },
    getReturn(asset, seconds) {
      return state.get(asset)?.returns?.get(seconds) ?? null;
    },
    getVolatility(asset) {
      return state.get(asset)?.volatility ?? null;
    },
    isConnected() {
      return connected;
    },
    snapshot() {
      return Object.fromEntries([...state.entries()].map(([asset, assetState]) => [asset, {
        price: assetState.price,
        volatility: assetState.volatility,
        returns: Object.fromEntries(assetState.returns.entries()),
        updatedAt: assetState.updatedAt,
      }]));
    },
    close() {
      manuallyStopped = true;
      if (activeController) activeController.abort();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanupSocket();
    },
  };
}

export default createBinanceFeed;

import { normalizeOpenOrdersResponse } from './runtime.js';

let tradingClient = null;

export function initOrderManager(client) {
  tradingClient = client;
}

function requireClient() {
  if (!tradingClient) {
    throw new Error('Order manager not initialized. Call initOrderManager(client) first.');
  }
  return tradingClient;
}

function normalizeOrderId(order) {
  return order?.orderID || order?.orderId || order?.id || order?.data?.orderID || order?.data?.orderId || null;
}

function isOpenOrder(order) {
  const status = String(order?.status || order?.state || '').toLowerCase();
  if (!status) return true;
  return !['cancelled', 'canceled', 'filled', 'matched', 'closed'].includes(status);
}

export async function placeMaker({ tokenId, side, price, size, tickSize = '0.01', negRisk = false }) {
  try {
    const client = requireClient();
    // For fee-enabled markets, the underlying CLOB client should handle fee-rate inclusion automatically.
    const response = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: Number(price).toFixed(2),
        size: Number(size).toFixed(2),
        side: String(side).toUpperCase(),
      },
      { tickSize, negRisk }
    );

    const orderId = normalizeOrderId(response);
    return {
      orderId,
      status: response?.status || response?.success || 'posted',
      price: Number(price),
      size: Number(size),
    };
  } catch (error) {
    console.error(`[order-manager] placeMaker failed: ${error.message}`);
    return null;
  }
}

export async function cancelOrder(orderId) {
  if (!orderId) return null;
  const client = requireClient();
  return client.cancel(orderId);
}

export async function getOpenOrders(tokenId = null) {
  const client = requireClient();
  const orders = normalizeOpenOrdersResponse(await client.getOrders()).filter(isOpenOrder);
  if (!tokenId) return orders;
  return orders.filter((order) => {
    const orderTokenId = order?.asset_id || order?.tokenID || order?.tokenId || order?.market || order?.conditionId;
    return String(orderTokenId) === String(tokenId);
  });
}

export async function cancelAllForToken(tokenId) {
  if (!tokenId) return [];
  const client = requireClient();
  try {
    return await client.cancelOrdersForMarket(tokenId);
  } catch (error) {
    console.error(`[order-manager] cancelAllForToken failed for ${tokenId}: ${error.message}`);
    return [];
  }
}

export async function cancelAll() {
  const openOrders = await getOpenOrders();
  const results = [];
  for (const order of openOrders) {
    const orderId = normalizeOrderId(order);
    if (!orderId) continue;
    try {
      results.push(await cancelOrder(orderId));
    } catch (error) {
      results.push({ orderId, error: error.message });
    }
  }
  return results;
}

export async function replaceOrder(orderId, newPrice, newSize) {
  const openOrders = await getOpenOrders();
  const existing = openOrders.find((order) => String(normalizeOrderId(order)) === String(orderId));
  if (!existing) {
    throw new Error(`Open order not found for replace: ${orderId}`);
  }

  const tokenId = existing?.asset_id || existing?.tokenID || existing?.tokenId;
  const side = existing?.side;
  const tickSize = existing?.tick_size || existing?.tickSize || '0.01';
  const negRisk = Boolean(existing?.neg_risk || existing?.negRisk);

  await cancelOrder(orderId);
  return placeMaker({ tokenId, side, price: newPrice, size: newSize, tickSize, negRisk });
}

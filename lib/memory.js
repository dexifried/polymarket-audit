const fs = require('fs');
const path = require('path');

const MEM_DIR = path.join(__dirname, '..', 'memory');
if (!fs.existsSync(MEM_DIR)) fs.mkdirSync(MEM_DIR, { recursive: true });

const files = {
  openOrders: path.join(MEM_DIR, 'open_orders.jsonl'),
  fills: path.join(MEM_DIR, 'fills.jsonl'),
  position: path.join(MEM_DIR, 'position_summary.jsonl'),
  heartbeat: path.join(MEM_DIR, 'heartbeat.jsonl')
};

function appendLine(file, obj) {
  const line = JSON.stringify(obj) + '\n';
  fs.appendFileSync(file, line, { mode: 0o600 });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// Open orders stored as JSON lines; maintain by orderId
function saveOpenOrder(order) {
  // remove existing with same orderId then append
  const current = getOpenOrders();
  const filtered = current.filter(o => o.orderId !== order.orderId);
  filtered.push(order);
  fs.writeFileSync(files.openOrders, filtered.map(o => JSON.stringify(o)).join('\n') + (filtered.length? '\n':'') , { mode: 0o600 });
}

function removeOpenOrder(orderId) {
  const current = getOpenOrders();
  const filtered = current.filter(o => o.orderId !== orderId);
  fs.writeFileSync(files.openOrders, filtered.map(o => JSON.stringify(o)).join('\n') + (filtered.length? '\n':'') , { mode: 0o600 });
}

function getOpenOrders() {
  return readLines(files.openOrders);
}

function saveFill(fill) {
  // append fill with timestamp if missing
  if (!fill.timestamp) fill.timestamp = Date.now();
  appendLine(files.fills, fill);
}

function getFills(limit = 100) {
  const all = readLines(files.fills);
  return all.slice(-limit);
}

function savePositionSummary(pos) {
  // overwrite with latest summary entry
  appendLine(files.position, Object.assign({ timestamp: Date.now() }, pos));
}

function getPositionSummary() {
  const all = readLines(files.position);
  if (!all.length) return null;
  return all[all.length - 1];
}

function touchHeartbeat() {
  const entry = { ts: Date.now() };
  appendLine(files.heartbeat, entry);
}

function getLastHeartbeat() {
  const all = readLines(files.heartbeat);
  if (!all.length) return null;
  return all[all.length - 1];
}

module.exports = {
  saveOpenOrder,
  removeOpenOrder,
  getOpenOrders,
  saveFill,
  getFills,
  savePositionSummary,
  getPositionSummary,
  touchHeartbeat,
  getLastHeartbeat
};

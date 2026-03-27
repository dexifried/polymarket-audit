import fs from 'fs/promises';
import path from 'path';

const DEFAULT_BASE = path.resolve(new URL('../', import.meta.url).pathname);
const DEFAULT_WAL_DIR = path.join(DEFAULT_BASE, '../wal');
const LOCK_RETRY_MS = 25;
const TAIL_POLL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptions(input = {}) {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input;
  }
  return { path: input };
}

function normalizeEntry(entry) {
  const normalized = { ...entry };
  if (normalized.timestamp == null) normalized.timestamp = Date.now();
  if (!normalized.source) normalized.source = 'unknown';
  return normalized;
}

function createWAL(options = {}) {
  const { path: walDir = DEFAULT_WAL_DIR, tailPollMs = TAIL_POLL_MS } = normalizeOptions(options);
  const logPath = path.join(walDir, 'log.jsonl');
  const countersPath = path.join(walDir, 'counters.json');
  const lockPath = path.join(walDir, 'append.lock');

  async function ensureDir() {
    await fs.mkdir(walDir, { recursive: true });
    await fs.writeFile(logPath, '', { flag: 'a' });
    try {
      await fs.writeFile(countersPath, JSON.stringify({}), { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  async function readCounters() {
    try {
      const raw = await fs.readFile(countersPath, 'utf8');
      return raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function writeCounters(counters) {
    const tmpPath = `${countersPath}.tmp-${process.pid}`;
    await fs.writeFile(tmpPath, JSON.stringify(counters), 'utf8');
    await fs.rename(tmpPath, countersPath);
  }

  async function readAllLines() {
    await ensureDir();
    const data = await fs.readFile(logPath, 'utf8');
    if (!data) return [];
    return data
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async function readLogMaxSeq(source) {
    const entries = await readAllLines();
    let maxSeq = 0;
    for (const entry of entries) {
      if (String(entry.source) !== source) continue;
      const seq = Number(entry.seq);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
    return maxSeq;
  }

  async function acquireLock() {
    while (true) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(String(process.pid), 'utf8');
        return handle;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  async function releaseLock(handle) {
    try {
      await handle.close();
    } finally {
      await fs.unlink(lockPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  function matchesFilter(entry, filter) {
    return typeof filter !== 'function' || filter(entry);
  }

  async function append(entry) {
    await ensureDir();
    const handle = await acquireLock();
    try {
      const normalized = normalizeEntry(entry);
      const source = String(normalized.source);
      const counters = await readCounters();
      const persistedSeq = Number(counters[source]) || 0;
      const loggedSeq = await readLogMaxSeq(source);
      const nextSeq = Math.max(persistedSeq, loggedSeq) + 1;
      if (normalized.seq == null) normalized.seq = nextSeq;
      counters[source] = Math.max(Number(normalized.seq) || 0, persistedSeq, loggedSeq);

      await fs.appendFile(logPath, `${JSON.stringify(normalized)}\n`, 'utf8');
      await writeCounters(counters);
      return normalized;
    } finally {
      await releaseLock(handle);
    }
  }

  async function tailLegacy(limit = 10) {
    const entries = await readAllLines();
    if (limit <= 0) return entries;
    return entries.slice(-limit);
  }

  async function replayLegacy(fromSeq = null, toSeq = null) {
    const entries = await readAllLines();
    return entries.filter((entry) => {
      if (fromSeq != null && entry.seq < fromSeq) return false;
      if (toSeq != null && entry.seq > toSeq) return false;
      return true;
    });
  }

  async function *replayStream(options = {}) {
    const { gt = null, gte = null, lt = null, lte = null, filter } = options;
    const entries = await readAllLines();
    for (const entry of entries) {
      const seq = Number(entry.seq);
      if (gt != null && !(seq > gt)) continue;
      if (gte != null && !(seq >= gte)) continue;
      if (lt != null && !(seq < lt)) continue;
      if (lte != null && !(seq <= lte)) continue;
      if (!matchesFilter(entry, filter)) continue;
      yield entry;
    }
  }

  async function *tailStream(options = {}) {
    const { after = null, gt = after, filter, pollMs = tailPollMs } = options;
    let cursor = gt ?? 0;
    while (true) {
      const entries = await readAllLines();
      for (const entry of entries) {
        const seq = Number(entry.seq);
        if (!Number.isFinite(seq) || seq <= cursor) continue;
        if (!matchesFilter(entry, filter)) continue;
        cursor = Math.max(cursor, seq);
        yield entry;
      }
      await sleep(pollMs);
    }
  }

  function replay(arg1 = null, arg2 = null) {
    if (typeof arg1 === 'object' && arg1 !== null && !Array.isArray(arg1)) {
      return replayStream(arg1);
    }
    return replayLegacy(arg1, arg2);
  }

  function tail(arg = 10) {
    if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
      return tailStream(arg);
    }
    return tailLegacy(arg);
  }

  return { append, replay, tail };
}

const defaultWAL = createWAL();

export const append = defaultWAL.append;
export const replay = defaultWAL.replay;
export const tail = defaultWAL.tail;

Object.assign(createWAL, defaultWAL);

export default createWAL;

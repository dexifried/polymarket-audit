import fs from 'fs/promises';
import { open as openSync } from 'fs';
import path from 'path';

const BASE = path.resolve(new URL('../', import.meta.url).pathname);
const WAL_DIR = path.join(BASE, '../wal');
const LOG_PATH = path.join(WAL_DIR, 'log.jsonl');
const COUNTERS_PATH = path.join(WAL_DIR, 'counters.json');

async function ensureDir(){
  try{
    await fs.mkdir(WAL_DIR, { recursive: true });
  }catch(e){/* ignore */}
  try{
    await fs.access(LOG_PATH);
  }catch(e){
    await fs.writeFile(LOG_PATH, '');
  }
  try{
    await fs.access(COUNTERS_PATH);
  }catch(e){
    await fs.writeFile(COUNTERS_PATH, JSON.stringify({}), { flag: 'wx' }).catch(()=>{});
  }
}

async function readCounters(){
  try{
    const raw = await fs.readFile(COUNTERS_PATH, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  }catch(e){
    return {};
  }
}

// persist counters atomically by writing to temp and renaming
async function writeCounters(counters){
  const tmp = COUNTERS_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(counters), { encoding: 'utf8' });
  await fs.rename(tmp, COUNTERS_PATH);
}

function normalizeEntry(entry){
  // basic normalization: ensure timestamp and source
  const e = Object.assign({}, entry);
  if(!e.timestamp) e.timestamp = Date.now();
  if(!e.source) e.source = 'unknown';
  return e;
}

export async function append(entry){
  await ensureDir();
  const e = normalizeEntry(entry);

  // assign seq if not provided: monotonic per source
  const counters = await readCounters();
  const src = String(e.source);
  const next = (counters[src] || 0) + 1;
  if(e.seq == null) e.seq = next;
  counters[src] = e.seq;
  // write counters before appending to ensure persistence of seqs
  await writeCounters(counters);

  const line = JSON.stringify(e) + '\n';
  // atomic append using fs.open with O_APPEND
  const fd = await new Promise((resolve,reject)=>{
    openSync(LOG_PATH, 'a', (err, fd)=>{
      if(err) reject(err); else resolve(fd);
    });
  });

  await new Promise((resolve,reject)=>{
    fs.writeFile(null, '').catch(()=>{}); // no-op to use fs promises available
    // use fs.appendFile for simplicity — it uses O_APPEND under the hood when file opened with 'a'
    // but to be extra careful, use fs.promises.appendFile
    fs.appendFile(LOG_PATH, line, 'utf8').then(()=>resolve()).catch(reject);
  });

  return e;
}

async function readAllLines(){
  await ensureDir();
  const data = await fs.readFile(LOG_PATH, 'utf8');
  if(!data) return [];
  const lines = data.split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch(e){ return null; } }).filter(Boolean);
}

export async function tail(limit = 10){
  const entries = await readAllLines();
  if(limit <= 0) return entries;
  return entries.slice(-limit);
}

export async function replay(fromSeq = null, toSeq = null){
  const entries = await readAllLines();
  // if fromSeq/toSeq are provided, they match per-source seq or global? We'll treat as global seq across log order.
  // fromSeq/toSeq will match entry.seq values (numeric). If null, unbounded.
  const res = [];
  for(const e of entries){
    if(fromSeq != null && e.seq < fromSeq) continue;
    if(toSeq != null && e.seq > toSeq) continue;
    res.push(e);
  }
  return res;
}

export default { append, tail, replay };

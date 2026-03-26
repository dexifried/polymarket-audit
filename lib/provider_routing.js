import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { SKILL_ROOT, loadEnvFallback } from './runtime.js';

const PAPER_DIR = resolve(SKILL_ROOT, 'memory', 'paper');
const ROUTING_PATH = resolve(SKILL_ROOT, 'config', 'model_routing.json');

loadEnvFallback();

export function ensurePaperDir() {
  mkdirSync(PAPER_DIR, { recursive: true });
}

export function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value) {
  ensurePaperDir();
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function nowIso() {
  return new Date().toISOString();
}

export function compactText(text, limit = 280) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export function loadRoutingConfig() {
  return readJson(ROUTING_PATH, {
    roles: {},
    defaults: {},
    policy: { mode: 'paper-only-advisory' },
  });
}

export function providerStatus() {
  return {
    deepinfra: Boolean(process.env.DEEPINFRA_API_KEY),
    cerebras: Boolean(process.env.CEREBRAS_KEY),
    sambanova: Boolean(process.env.SAMBANOVA_KEY),
    huggingface: Boolean(process.env.HF_TOKEN && process.env.HF_USERNAME),
  };
}

export function buildRoutingSummary() {
  const config = loadRoutingConfig();
  const status = providerStatus();
  return {
    generatedAt: nowIso(),
    mode: config?.policy?.mode || 'paper-only-advisory',
    budgetGoal: config?.policy?.budgetGoal || null,
    providers: Object.entries(config?.roles || {}).map(([name, spec]) => ({
      name,
      enabled: Boolean(status[name]),
      role: spec.role || null,
      fallback: spec.fallback || null,
      budgetNotes: spec.budgetNotes || null,
    })),
  };
}

export async function postJson(url, apiKey, payload, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${compactText(text, 300)}`);
    }

    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

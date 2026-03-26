#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import { SKILL_ROOT } from '../lib/runtime.js';
import {
  buildRoutingSummary,
  compactText,
  loadRoutingConfig,
  nowIso,
  postJson,
  providerStatus,
  readJson,
  writeJson,
} from '../lib/provider_routing.js';

const args = minimist(process.argv.slice(2));
const paperDir = resolve(SKILL_ROOT, 'memory', 'paper');
const decisionsPath = resolve(paperDir, 'decisions.jsonl');
const tradesPath = resolve(paperDir, 'trades.jsonl');
const outputPath = resolve(paperDir, 'batch_labels_latest.json');

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
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

function inferLocalLabel(item) {
  const type = String(item.type || '').toUpperCase();
  const note = `${item.note || ''} ${item.reason || ''} ${item.rationale || ''}`.toLowerCase();
  if (type === 'BUY' || type === 'ENTRY') return 'entry_signal';
  if (type === 'EXIT') return Number(item.pnlUsd) > 0 ? 'profitable_exit' : Number(item.pnlUsd) < 0 ? 'loss_exit' : 'flat_exit';
  if (type === 'PAUSE') return 'risk_pause';
  if (type === 'NO_TRADE') return 'filtered_no_trade';
  if (note.includes('hold')) return 'hold_review';
  return 'operator_log';
}

function stringifyNote(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value == null ? '' : String(value);
}

function buildItems() {
  if (args.input) {
    const json = readJson(String(args.input), []);
    return Array.isArray(json) ? json : [json];
  }

  const decisions = readJsonl(decisionsPath).slice(-6);
  const trades = readJsonl(tradesPath).slice(-4);
  const items = [...decisions, ...trades]
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
    .slice(-(Number(args.limit) || 8));

  return items.map((item) => ({
    ts: item.ts || null,
    type: item.type || null,
    question: compactText(item.question, 140),
    note: compactText(stringifyNote(item.note || item.reason || item.rationale || ''), 180),
    pnlUsd: item.pnlUsd ?? null,
    result: item.result || null,
  }));
}

function buildPrompt(items) {
  return [
    'Return compact JSON only.',
    'Summarize this paper-trading batch for offline analysis.',
    'Schema:',
    '{"summary":"short string","labels":[{"ts":"iso","type":"string","label":"string","confidence":0.0,"reason":"short string"}],"patterns":["short string"]}',
    'Keep labels <= number of input items, patterns <= 3, and reasons short.',
    JSON.stringify({ items }),
  ].join('\n');
}

async function callSambaNova(items) {
  const config = loadRoutingConfig();
  const timeoutMs = config?.defaults?.batchLabeler?.timeoutMs || 25000;
  const model = String(args.model || process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.1-8B-Instruct');
  const json = await postJson(
    'https://api.sambanova.ai/v1/chat/completions',
    process.env.SAMBANOVA_KEY,
    {
      model,
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are an offline batch labeler for a paper-only trading workflow.' },
        { role: 'user', content: buildPrompt(items) },
      ],
    },
    { timeoutMs }
  );
  const parsed = JSON.parse(json?.choices?.[0]?.message?.content || '{}');
  return {
    provider: 'sambanova',
    model,
    usage: json?.usage || null,
    parsed,
  };
}

function localBatch(items) {
  const labels = items.map((item) => ({
    ts: item.ts || null,
    type: item.type || 'UNKNOWN',
    label: inferLocalLabel(item),
    confidence: 0.55,
    reason: compactText(item.note || item.result || item.question || 'rule-based offline label', 120),
  }));

  const typeCounts = labels.reduce((acc, item) => {
    acc[item.label] = (acc[item.label] || 0) + 1;
    return acc;
  }, {});

  const patterns = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, count]) => `${label}:${count}`);

  return {
    summary: `Local batch labeler processed ${items.length} paper-trading records.`,
    labels,
    patterns,
  };
}

async function main() {
  const items = buildItems();
  const status = providerStatus();
  const routing = buildRoutingSummary();
  let provider = 'local';
  let model = null;
  let usage = null;
  let providerError = null;
  let output = localBatch(items);

  if (status.sambanova && !args['local-only'] && items.length) {
    try {
      const remote = await callSambaNova(items);
      provider = remote.provider;
      model = remote.model;
      usage = remote.usage;
      output = {
        summary: compactText(remote.parsed?.summary, 220) || output.summary,
        labels: Array.isArray(remote.parsed?.labels) ? remote.parsed.labels.slice(0, items.length) : output.labels,
        patterns: Array.isArray(remote.parsed?.patterns) ? remote.parsed.patterns.slice(0, 3) : output.patterns,
      };
    } catch (error) {
      providerError = error.message;
    }
  }

  const record = {
    ts: nowIso(),
    advisoryOnly: true,
    provider,
    model,
    providerAvailable: status.sambanova,
    providerError,
    routing,
    itemCount: items.length,
    items,
    output,
    usage,
  };

  writeJson(outputPath, record);
  console.log(JSON.stringify(record, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

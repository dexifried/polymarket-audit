#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import minimist from 'minimist';
import { SKILL_ROOT } from '../lib/runtime.js';
import { buildRoutingSummary, compactText, nowIso, providerStatus, readJson } from '../lib/provider_routing.js';

const args = minimist(process.argv.slice(2));
const paperDir = resolve(SKILL_ROOT, 'memory', 'paper');
const outDir = resolve(SKILL_ROOT, 'references', 'hf_exports');
const accountPath = resolve(paperDir, 'account.json');
const decisionsPath = resolve(paperDir, 'decisions.jsonl');
const watchdogPath = resolve(paperDir, 'qwen_watchdog.jsonl');
const judgePath = resolve(paperDir, 'ambiguity_judge_latest.json');
const outputPath = resolve(outDir, String(args.output || 'paper_training_data.jsonl'));

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

function toExamples() {
  const account = readJson(accountPath, {});
  const decisions = readJsonl(decisionsPath);
  const watchdog = readJsonl(watchdogPath);
  const judge = readJson(judgePath, {});
  const limit = Math.max(1, Number(args.limit) || 200);

  const examples = decisions.slice(-limit).map((item) => {
    const nearWatchdog = watchdog.find((entry) => entry.ts && item.ts && Math.abs(new Date(entry.ts).getTime() - new Date(item.ts).getTime()) < 10 * 60 * 1000);
    return {
      instruction: 'Review this paper-trading event and provide a cautious advisory classification. Do not propose live trading.',
      input: {
        accountRisk: {
          paused: Boolean(account?.risk?.paused),
          pauseReason: account?.risk?.pauseReason || null,
          drawdownUsd: account?.risk?.drawdownUsd ?? null,
          todayLossUsd: account?.risk?.todayLossUsd ?? null,
        },
        event: {
          ts: item.ts || null,
          type: item.type || null,
          question: compactText(item.question, 180),
          note: compactText(item.note || item.rationale || item.reason || '', 200),
        },
        watchdog: nearWatchdog ? {
          overallVerdict: nearWatchdog.overallVerdict || null,
          summary: compactText(nearWatchdog.summary, 180),
          riskFlags: Array.isArray(nearWatchdog.riskFlags) ? nearWatchdog.riskFlags.slice(0, 6) : [],
        } : null,
        ambiguityJudge: judge?.output ? {
          verdict: judge.output.verdict || null,
          reasons: Array.isArray(judge.output.reasons) ? judge.output.reasons.slice(0, 3) : [],
        } : null,
      },
      output: {
        advisoryClass: item.type === 'BUY' ? 'observe_entry' : item.type === 'PAUSE' ? 'risk_pause' : item.type === 'NO_TRADE' ? 'filtered_no_trade' : 'paper_log',
        rationale: compactText(item.note || item.reason || item.rationale || 'paper-only training example', 180),
      },
      metadata: {
        exportedAt: nowIso(),
        source: 'polymarket-paper-trader',
        liveTrading: false,
      },
    };
  });

  return examples;
}

mkdirSync(outDir, { recursive: true });
const examples = toExamples();
writeFileSync(outputPath, `${examples.map((row) => JSON.stringify(row)).join('\n')}\n`);

console.log(JSON.stringify({
  ts: nowIso(),
  advisoryOnly: true,
  providerRouting: buildRoutingSummary(),
  huggingfaceReady: providerStatus().huggingface,
  outputPath,
  exampleCount: examples.length,
}, null, 2));

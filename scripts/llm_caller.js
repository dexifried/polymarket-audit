#!/usr/bin/env node
/**
 * LLM Caller for TradingAgents pipeline.
 * Reads JSON messages from stdin, calls OpenRouter API, writes response to stdout.
 *
 * Usage: echo '{"messages":[...]}' | node scripts/llm_caller.js
 * Env:   OPENROUTER_API_KEY (from .env)
 *        LLM_MODEL (default: anthropic/claude-sonnet-4-6)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load API key from .env
function loadEnv() {
  try {
    const envPath = resolve(import.meta.dirname, '../../.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* .env not found, rely on process.env */ }
}

loadEnv();

const PROVIDER = process.env.LLM_PROVIDER || 'deepinfra';
const MODEL = process.env.LLM_MODEL || 'meta-llama/Meta-Llama-3.1-70B-Instruct';

const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  deepinfra: {
    url: process.env.DEEPINFRA_CHAT_ENDPOINT || 'https://api.deepinfra.com/v1/openai/chat/completions',
    keyEnv: 'DEEPINFRA_API_KEY',
  },
  groq: {
    url: process.env.GROQ_ENDPOINT || 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_KEY',
  },
  cerebras: {
    url: process.env.CEREBRAS_ENDPOINT || 'https://api.cerebras.ai/v1/chat/completions',
    keyEnv: 'CEREBRAS_KEY',
  },
};

const provider = PROVIDERS[PROVIDER] || PROVIDERS.deepinfra;
const API_KEY = process.env[provider.keyEnv];
const API_URL = provider.url;
const TIMEOUT_MS = 90_000;

async function callLLM(messages) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function main() {
  if (!API_KEY) {
    process.stderr.write('ERROR: OPENROUTER_API_KEY not set\n');
    process.exit(1);
  }

  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let request;
  try {
    request = JSON.parse(input);
  } catch (e) {
    process.stderr.write(`ERROR: Invalid JSON input: ${e.message}\n`);
    process.exit(1);
  }

  // Handle both [{role, content}...] and {messages: [{role, content}...]}
  const messages = Array.isArray(request) ? request : (request.messages || request);
  if (!Array.isArray(messages)) {
    process.stderr.write('ERROR: Expected { messages: [...] } or [...] array\n');
    process.exit(1);
  }

  try {
    const response = await callLLM(messages);
    process.stdout.write(response);
  } catch (e) {
    process.stderr.write(`ERROR: LLM call failed: ${e.message}\n`);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
'use strict'

// Exit codes:
// 0 - dry-run SAFE: required config present and NO real credentials detected
// 1 - dry-run NOT SAFE: credentials present (live) or required config missing
// 2 - usage / error

const fs = require('fs')
const path = require('path')

function fileExists(p) { try { return fs.existsSync(p) } catch (e) { return false } }

const cwd = process.cwd()
const credsPath = path.join(cwd, '.polymarket-credentials.json')
const marketsPath = path.join(cwd, 'skills', 'polymarket-trading.skill', 'config', 'markets.json')

// Basic checks
if (!fileExists(marketsPath)) {
  console.error('Missing required config: config/markets.json')
  process.exit(2)
}

if (!fileExists(credsPath)) {
  console.log('OK: .polymarket-credentials.json not present — dry-run is safe')
  process.exit(0)
}

// If credentials file exists, inspect for obvious placeholders
try {
  const raw = fs.readFileSync(credsPath, 'utf8')
  const parsed = JSON.parse(raw || '{}')
  const { apiKey, secret } = parsed
  const placeholders = ['REPLACE_ME', 'your_api_key', 'your-secret']
  const looksFake = (val) => !val || placeholders.includes(String(val).trim())

  if (looksFake(apiKey) && looksFake(secret)) {
    console.log('OK: credentials look like placeholders — dry-run considered SAFE')
    process.exit(0)
  }

  // Also treat presence of PRIVATE_KEY env as a sign of live-run capability
  if (process.env.PRIVATE_KEY) {
    console.error('LIVE CREDENTIALS DETECTED: PRIVATE_KEY present in env — dry-run NOT safe')
    process.exit(1)
  }

  console.error('.polymarket-credentials.json present and looks like real credentials — dry-run NOT safe')
  process.exit(1)
} catch (e) {
  console.error('Failed to inspect credentials file:', e && e.message)
  process.exit(2)
}

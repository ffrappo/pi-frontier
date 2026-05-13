#!/usr/bin/env node
// frontier.js — surface the single latest model per family/tier from filtered list.
//
// Outputs two tables:
//  1. FRONTIER — one model per provider×family (highest version/date).
//  2. BY PROVIDER × TIER — for major providers, show the frontier model
//     for each tier (flash, pro, mini, nano, etc.).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN = join(__dirname, '..', 'data', 'filtered_models.json');
const data = JSON.parse(readFileSync(IN, 'utf-8'));

// ── tier heuristics ─────────────────────────────────────────────────
const TIER_KEYWORDS = [
  { tier: 'pro',        re: /\bpro\b/i,         rank: 1 },
  { tier: 'flash',      re: /\bflash\b/i,       rank: 2 },
  { tier: 'mini',       re: /\bmini\b/i,        rank: 3 },
  { tier: 'nano',       re: /\bnano\b/i,        rank: 4 },
  { tier: 'lite',       re: /\blite\b/i,        rank: 5 },
  { tier: 'fast',       re: /\bfast\b/i,        rank: 6 },
  { tier: 'reasoning',  re: /\breason(?:ing|er)\b/i, rank: 7 },
  { tier: 'vision',     re: /\bvision\b/i,      rank: 8 },
  { tier: 'code',       re: /\bcod(?:e|er|estral)\b/i,  rank: 9 },
  { tier: 'opus',       re: /\bopus\b/i,        rank: 10 },
  { tier: 'sonnet',     re: /\bsonnet\b/i,      rank: 11 },
  { tier: 'haiku',      re: /\bhaiku\b/i,       rank: 12 },
];

function normalizeFamily(key) {
  let n = key
    .replace(/-\d{4}-\d{2}-\d{2}.*/, '')
    .replace(/-\d{8}.*/, '')
    .replace(/-v\d+:\d+/, '')
    .replace(/:\d+$/, '')
    .replace(/@\d+.*/, '')
    .trim();

  // Merge minor versions: gpt-5.4 → gpt-5 family
  n = n.replace(/^(gpt-\d+)\.\d+/, '$1');
  return n;
}

function extractDate(name) {
  let m = name.match(/(20[12]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}`);
  m = name.match(/(20[12]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}`);
  m = name.match(/(20[12]\d)-(0[1-9]|1[0-2])/);
  if (m) return new Date(`${m[1]}-${m[2]}-01`);
  return null;
}

function detectTier(key) {
  for (const { tier, re } of TIER_KEYWORDS) {
    if (re.test(key)) return tier;
  }
  return 'base';
}

// ── gather chat/completion models ───────────────────────────────────
const chat = {};
for (const [key, val] of Object.entries(data)) {
  const mode = val.mode || '';
  if (mode !== 'chat' && mode !== 'completion' && !key.startsWith('gpt-')) continue;
  if (['embedding','image_generation','audio_transcription','audio_speech','moderation','rerank'].includes(mode)) continue;

  const provider = val.litellm_provider || 'unknown';
  const family = normalizeFamily(key);
  const date = extractDate(key);
  const tier = detectTier(key);

  chat[key] = { ...val, _key: key, _provider: provider, _family: family, _date: date, _tier: tier };
}

// ── frontier: pick latest per provider×family ──────────────────────
const frontierMap = new Map();

for (const [key, m] of Object.entries(chat)) {
  const pf = `${m._provider}::${m._family}`;
  const cur = frontierMap.get(pf);
  if (!cur || (m._date && (!cur._date || m._date > cur._date))) {
    frontierMap.set(pf, m);
  }
}

const frontier = [...frontierMap.values()].sort((a, b) =>
  a._provider.localeCompare(b._provider) || a._family.localeCompare(b._family)
);

// ── OUTPUT TABLE 1: FRONTIER ───────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log('  TABLE 1 — FRONTIER MODELS (latest per provider × family)');
console.log('══════════════════════════════════════════════════════════\n');

const rows1 = frontier.map(m => ({
  Provider: m._provider,
  Family: m._family,
  'Model Key': m._key,
  Date: m._date ? m._date.toISOString().slice(0,10) : '—',
  Tier: m._tier,
  'Max Input': m.max_input_tokens || m.max_tokens || '—',
  'Max Output': m.max_output_tokens || '—',
}));

console.table(rows1.slice(0, 100));

// ── OUTPUT TABLE 2: MAJOR PROVIDERS × TIERS ────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log('  TABLE 2 — MAJOR PROVIDERS × TIERS (frontier per tier)');
console.log('══════════════════════════════════════════════════════════\n');

const ALL_PROVIDERS = [...new Set(frontier.map(m => m._provider))].sort();

for (const provider of ALL_PROVIDERS) {
  const models = frontier.filter(m => m._provider === provider);
  if (models.length === 0) { console.log(`\n${provider.toUpperCase()}: (none)\n`); continue; }

  console.log(`\n─── ${provider.toUpperCase()} ───`);

  const byTier = new Map();
  for (const m of models) {
    const t = m._tier;
    const cur = byTier.get(t);
    if (!cur || (m._date && (!cur._date || m._date > cur._date))) {
      byTier.set(t, m);
    }
  }

  const tierRows = [...byTier.entries()]
    .sort(([,a], [,b]) => (b._date || 0) - (a._date || 0))
    .map(([tier, m]) => ({
      Tier: tier,
      'Model Key': m._key,
      Date: m._date ? m._date.toISOString().slice(0,10) : '—',
      'Max Input': m.max_input_tokens || m.max_tokens || '—',
      'Max Output': m.max_output_tokens || '—',
    }));

  console.table(tierRows);
}

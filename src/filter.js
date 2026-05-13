#!/usr/bin/env node
// filter.js — apply filters to raw model list:
//  1. Drop any model that has a deprecation_date field (any value).
//  2. Drop models whose NAME contains a date older than MONTHS_THRESHOLD (default 6).
//  3. Drop explicit junk patterns (legacy, bedrock routing spam, quantizations).
//  4. Deduplicate Bedrock regional variants (us., eu., au., global., bedrock/region/).
//  5. Deduplicate cross-provider reseller copies — keep canonical provider only.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN   = join(__dirname, '..', 'data', 'raw_models.json');
const OUT  = join(__dirname, '..', 'data', 'filtered_models.json');

const MONTHS_THRESHOLD = parseInt(process.env.MONTHS_THRESHOLD || '6', 10);
const now = new Date();
const CUTOFF = new Date(now.getFullYear(), now.getMonth() - MONTHS_THRESHOLD, now.getDate());

// Canonical providers — model creators, not resellers or cloud gateways.
// When the same logical model appears across providers, prefer these.
const CANONICAL_PROVIDERS = new Set([
  'openai', 'anthropic', 'gemini', 'mistral', 'codestral',
  'cohere', 'cohere_chat', 'deepseek', 'xai', 'ai21',
  'moonshot', 'dashscope', 'meta_llama', 'minimax', 'zai',
  'volcengine',
]);

// ── helpers ────────────────────────────────────────────────────────
function isLegacyOrJunk(name) {
  // 1. OpenAI 4-digit legacy date codes indicating 2023/2024
  if (/(?:-|_)(0314|0613|1106|0125|0409|0718)(?:-|_|$)/.test(name)) return true;
  
  // 2. Officially obsolete model families (Llama 2, Claude 1/2, GPT 3.5)
  if (/\b(?:claude-?v?[12]|claude-instant|gpt-3\.?5)\b/i.test(name)) return true;
  if (/\bllama-?2\b/i.test(name) && !/llama-?3/i.test(name)) return true;
  
  // 3. Bedrock region / commitment spam (e.g. bedrock/us-east-1/...)
  if (/^bedrock\/([a-z]+-[a-z]+-\d+|\*)\//.test(name)) return true;
  
  // 4. Quantization / framework suffixes
  if (/(?:-|_)(hf|gguf|awq|int8|fp8|mxfp)(?:-|_|$)/i.test(name)) return true;
  
  // 5. Fine-tuning placeholders
  if (/^ft:/.test(name)) return true;
  
  return false;
}

function extractDate(name) {
  let m = name.match(/(20[12]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
  if (m) { const d = new Date(`${m[1]}-${m[2]}-${m[3]}`); if (!isNaN(d)) return d; }
  m = name.match(/(20[12]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (m) { const d = new Date(`${m[1]}-${m[2]}-${m[3]}`); if (!isNaN(d)) return d; }
  m = name.match(/(20[12]\d)-(0[1-9]|1[0-2])/);
  if (m) { const d = new Date(`${m[1]}-${m[2]}-01`); if (!isNaN(d)) return d; }
  return null;
}

// Normalize a model key to its logical name for cross-provider dedup.
// Strips provider prefixes, region prefixes, and lowercases.
function normalizeModelKey(key, provider) {
  let n = key;
  // Strip provider prefix (e.g. "openrouter/openai/gpt-4o" → "gpt-4o")
  const esc = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  n = n.replace(new RegExp('^' + esc + '[/_]'), '');
  // Strip region prefixes — both dot (Bedrock: us., eu.) and slash (Azure: us/, eu/, global/)
  n = n.replace(/^(us|eu|au|global|ap|sa|me)[./]/, '');
  n = n.replace(/^[a-z]+-[a-z]+-[a-z]*\d+\//, '');
  n = n.replace(/^us-gov-[a-z]+-\d+\//, '');
  // Strip vendor dot-prefixes
  n = n.replace(/^(anthropic|meta|amazon|writer|twelvelabs)\./, '');
  // Strip "openai/" within name (reseller pattern)
  n = n.replace(/^openai[/_]/, '');
  return n.toLowerCase();
}

// ── main ───────────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(IN, 'utf-8'));

let total = 0, droppedDep = 0, droppedOld = 0, droppedJunk = 0;
const afterBasic = {};  // entries surviving filters 1-3

for (const [key, val] of Object.entries(data)) {
  if (key === 'sample_spec' || typeof val !== 'object' || !val) continue;
  total++;

  // Filter 1: deprecation_date
  if (val.deprecation_date && val.deprecation_date !== '') { droppedDep++; continue; }

  // Filter 2: Explicit junk patterns
  if (isLegacyOrJunk(key)) { droppedJunk++; continue; }

  // Filter 3: stale date in name
  const d = extractDate(key);
  if (d && d < CUTOFF) { droppedOld++; continue; }

  afterBasic[key] = val;
}

// ── Filter 4: Bedrock regional dedup ─────────────────────────────
// Group bedrock entries by normalized name; keep regionless or first region.
const bedrockRegionalGroups = new Map();
const nonBedrock = {};

for (const [key, val] of Object.entries(afterBasic)) {
  const provider = val.litellm_provider || '';
  if (provider === 'bedrock' || provider === 'bedrock_converse') {
    const norm = normalizeModelKey(key, provider);
    if (!bedrockRegionalGroups.has(norm)) bedrockRegionalGroups.set(norm, []);
    bedrockRegionalGroups.get(norm).push({ key, val });
  } else {
    nonBedrock[key] = val;
  }
}

let droppedRegional = 0;
const afterRegional = { ...nonBedrock };

for (const [norm, entries] of bedrockRegionalGroups) {
  // Check if a regionless entry exists
  const regionless = entries.filter(e =>
    !/^(us|eu|au|global|ap|sa|me)\./.test(e.key) &&
    !/^bedrock\//.test(e.key)
  );
  if (regionless.length > 0) {
    // Keep all regionless entries (might be converse + regular), drop regionals
    for (const e of regionless) afterRegional[e.key] = e.val;
    droppedRegional += entries.length - regionless.length;
  } else {
    // All are regional — keep one, drop the rest
    const kept = entries[0];
    afterRegional[kept.key] = kept.val;
    droppedRegional += entries.length - 1;
  }
}

// ── Filter 5: Cross-provider reseller dedup ────────────────────────
// Normalize all remaining entries; when the same logical model appears
// on multiple providers, keep only the canonical (or shortest-key) entry.
const crossGroups = new Map();

for (const [key, val] of Object.entries(afterRegional)) {
  const provider = val.litellm_provider || 'unknown';
  const norm = normalizeModelKey(key, provider);
  if (!crossGroups.has(norm)) crossGroups.set(norm, []);
  crossGroups.get(norm).push({ key, val, provider });
}

let droppedDupes = 0;
const kept = {};

for (const [norm, entries] of crossGroups) {
  if (entries.length === 1) {
    kept[entries[0].key] = entries[0].val;
    continue;
  }

  // Multi-provider group — pick the winner
  // Priority: 1) canonical provider, 2) shortest key
  const canonicals = entries.filter(e => CANONICAL_PROVIDERS.has(e.provider));
  const candidates = canonicals.length > 0 ? canonicals : entries;
  
  // Among candidates, pick the one with the shortest key
  candidates.sort((a, b) => a.key.length - b.key.length);
  const winner = candidates[0];
  
  kept[winner.key] = winner.val;
  droppedDupes += entries.length - 1;
}

// ── write output ───────────────────────────────────────────────────
writeFileSync(OUT, JSON.stringify(kept, null, 2));

console.log(`Total: ${total}`);
console.log(`  deprecated:     ${droppedDep}`);
console.log(`  junk patterns:  ${droppedJunk}`);
console.log(`  name-too-old:   ${droppedOld}`);
console.log(`  bedrock region: ${droppedRegional}`);
console.log(`  cross-provider: ${droppedDupes}`);
console.log(`  ─────────────────────`);
const totalDropped = droppedDep + droppedJunk + droppedOld + droppedRegional + droppedDupes;
console.log(`  kept:           ${Object.keys(kept).length}  (${totalDropped} dropped)`);
console.log(`Cutoff date: ${CUTOFF.toISOString().slice(0,10)} (${MONTHS_THRESHOLD} months ago)`);
console.log(`→ ${OUT}`);

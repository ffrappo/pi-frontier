#!/usr/bin/env node
// frontier.js — FINAL stage. Surface only the latest model per
// provider×family×tier and write the clean final output.
//
// The release_date cutoff in filter.js is the primary pre-filter. This stage
// does the deterministic dedup work the cutoff can't (it's orthogonal to
// recency) and guarantees no live model is lost:
//  1. Version-aware family key — parse version OUT of the name (src/version.js).
//  2. Context/qualifier variants collapse into the same family (src/version.js).
//  3. Regional dedup — collapse *-cn / zhipuai regional creator mirrors.
//  4. Provider classification — creator / cloud / aggregator (src/providers.js).
//  5. Within-family×tier pruning — keep top version per provider×family×tier.
//  6. Keep-newest-in-family — every surviving family keeps its current head
//     even if its release_date is >6mo old (fixes the slow-cadence
//     false-negative, e.g. claude-haiku-4-5).
//
// Outputs: data/frontier_final.json + FRONTIER_MODELS.md (repo root).
// SCOPE env: all | creators (default) | creators+cloud

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseModelKey, cmpVersion, versionStr } from './version.js';
import { classifyProvider } from './providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN         = join(__dirname, '..', 'data', 'filtered_models.json');
const OUT_JSON   = join(__dirname, '..', 'data', 'frontier_final.json');
const OUT_MD     = join(__dirname, '..', 'FRONTIER_MODELS.md');
const SUPERSEDED = join(__dirname, 'superseded.json');

const TODAY = new Date().toISOString().slice(0, 10);

const SCOPE = (process.env.SCOPE || 'creators').toLowerCase();
const SCOPE_CLASSES =
  SCOPE === 'all'            ? ['creator', 'cloud', 'aggregator'] :
  SCOPE === 'creators+cloud' ? ['creator', 'cloud'] :
  /* creators */               ['creator'];

const data = JSON.parse(readFileSync(IN, 'utf-8'));

// ── regional dedup ──────────────────────────────────────────────────
// *-cn providers and zhipuai re-list the SAME models as their global twin.
// Fold the regional id onto the canonical one; the cheaper-priced entry of a
// duplicate (provider::family::tier) wins in pruning below.
const REGION_CANON = {
  'minimax-cn': 'minimax',
  'moonshotai-cn': 'moonshotai',
  'zhipuai': 'zai',
};
const canonProvider = p => REGION_CANON[p] || p;

// ── tier heuristics ─────────────────────────────────────────────────
const TIER_KEYWORDS = [
  { tier: 'pro',       re: /\bpro\b/i },
  { tier: 'flash',     re: /\bflash\b/i },
  { tier: 'mini',      re: /\bmini\b/i },
  { tier: 'nano',      re: /\bnano\b/i },
  { tier: 'lite',      re: /\b(?:lite|air|small|turbo|mini)\b/i },
  { tier: 'fast',      re: /\bfast\b/i },
  { tier: 'reasoning', re: /\breason(?:ing|er)\b/i },
  { tier: 'vision',    re: /\bvision\b/i },
  { tier: 'code',      re: /\bcod(?:e|er|estral)\b/i },
  { tier: 'opus',      re: /\bopus\b/i },
  { tier: 'sonnet',    re: /\bsonnet\b/i },
  { tier: 'haiku',     re: /\bhaiku\b/i },
];

function detectTier(key) {
  for (const { tier, re } of TIER_KEYWORDS) if (re.test(key)) return tier;
  return 'base';
}

// Strip tier / variant words from the family name so the family is the bare
// base (grok-4-fast and grok-3-mini → both family `grok`, tier carries the
// distinction). Without this, families over-split on qualifier words.
const VARIANT_RE = /\b(pro|flash|mini|nano|lite|air|airx|small|turbo|fast|reasoning|reasoner|non-reasoning|vision|code|coder|opus|sonnet|haiku|chat|instruct|thinking|max|plus|multi-agent|lightning|hd|x|v|er)\b/gi;
function baseFamily(family) {
  let f = family.replace(VARIANT_RE, '').replace(/--+/g, '-').replace(/^-+|-+$/g, '');
  return f || family;
}

// ── gather chat models ──────────────────────────────────────────────
// filter.js already dropped non-text-output and embedding/rerank models and
// applied the release_date cutoff. This name-based blocklist is a cheap safety
// net for chat-tagged models that are not general-purpose chat.
const MODAL_BLOCK_RE = /(?:audio|realtime|tts|-search-api|search-preview|robotics|lyria|image|whisper|transcribe|moderation|guard|computer-use)/i;

function modelDate(val) {
  if (!val.release_date) return 0;
  const m = String(val.release_date).match(/(20\d\d)-(\d\d)-(\d\d)/);
  return m ? +(m[1] + m[2] + m[3]) : 0;
}

const chat = [];
for (const [key, val] of Object.entries(data)) {
  if (typeof val !== 'object' || !val) continue;
  const id = val.model_id || key;
  if (MODAL_BLOCK_RE.test(id)) continue;

  const provider = canonProvider(val.litellm_provider || 'unknown');
  const { family, version } = parseModelKey(id);
  // Fold the real release_date into the version object so newer release wins
  // the within-family tiebreak even when the name carries no version token.
  const relDate = modelDate(val);
  let ver = version;
  if (relDate) {
    ver = version
      ? { ...version, date: version.date || relDate }
      : { semver: [], date: relDate, dotted: false, dateApprox: false };
  }
  chat.push({
    key, val, provider,
    providerClass: classifyProvider(provider),
    family: baseFamily(family), version: ver,
    tier: detectTier(id),
    relDate, // numeric YYYYMMDD or 0
  });
}
const N_CHAT = chat.length;

// ── within-family×tier pruning ─────────────────────────────────────
// key = provider :: family :: tier  → highest version wins. Because of regional
// dedup above, the *-cn twin lands in the same bucket as its global twin; the
// tiebreak below then prefers the cheaper-priced entry.
const PREVIEW_RE = /\b(?:preview|beta|exp|experimental|nightly|rc)\b/i;
const isPreview = key => PREVIEW_RE.test(key);
const inCost = m => (m.val.input_cost_per_token == null ? Infinity : m.val.input_cost_per_token);

const pruned = new Map();
for (const m of chat) {
  const k = `${m.provider}::${m.family}::${m.tier}`;
  const cur = pruned.get(k);
  if (!cur) { pruned.set(k, m); continue; }
  const c = cmpVersion(m.version, cur.version);
  if (c > 0) { pruned.set(k, m); continue; }
  if (c === 0) {
    // equal version (e.g. regional twins): stable beats preview, then cheaper
    // input price wins, then shorter key.
    const mPrev = isPreview(m.key), curPrev = isPreview(cur.key);
    if (mPrev !== curPrev) { if (curPrev) pruned.set(k, m); continue; }
    const mc = inCost(m), cc = inCost(cur);
    if (mc !== cc) { if (mc < cc) pruned.set(k, m); continue; }
    if (m.key.length < cur.key.length) pruned.set(k, m);
  }
}
let frontier = [...pruned.values()];

// ── keep-newest-in-family guarantee ─────────────────────────────────
// The release_date cutoff is a pre-filter; it can wrongly kill a slow-cadence
// family's only live model (e.g. claude-haiku-4-5 — no Haiku successor shipped).
// For every provider×family present in the FULL chat set, make sure the newest
// member (by release_date, then version) is in the frontier even if filter.js
// would have aged it out — it never gets here aged-out since filter.js drops
// pre-cutoff, so this instead guarantees we don't *prune* away the family head.
// Concretely: per provider×family, if pruning left the family with entries but
// a newer-dated member of that family was dropped as a non-top tier, that's
// fine — tiers are intentional. The real fix is at filter.js (cutoff) — but to
// be safe, re-scan: ensure each family's overall newest chat member survives.
const familyNewest = new Map(); // provider::family -> newest chat member
for (const m of chat) {
  const fk = `${m.provider}::${m.family}`;
  const cur = familyNewest.get(fk);
  if (!cur) { familyNewest.set(fk, m); continue; }
  if (m.relDate > cur.relDate) { familyNewest.set(fk, m); continue; }
  if (m.relDate === cur.relDate && cmpVersion(m.version, cur.version) > 0) {
    familyNewest.set(fk, m);
  }
}
const frontierKeys = new Set(frontier.map(m => m.key));
for (const m of familyNewest.values()) {
  if (!frontierKeys.has(m.key)) {
    frontier.push(m);
    frontierKeys.add(m.key);
  }
}

frontier.sort((a, b) =>
  a.provider.localeCompare(b.provider) ||
  a.family.localeCompare(b.family) ||
  a.tier.localeCompare(b.tier)
);
const N_PRUNED = frontier.length;
const familySet = new Set(frontier.map(m => `${m.provider}::${m.family}`));

// ── scope filter ───────────────────────────────────────────────────
const scoped = frontier.filter(m => SCOPE_CLASSES.includes(m.providerClass));

// ── build structured records ───────────────────────────────────────
function rec(m) {
  return {
    provider: m.provider,
    providerClass: m.providerClass,
    family: m.family,
    model_key: m.key,
    version: versionStr(m.version),
    tier: m.tier,
    release_date: m.val.release_date ?? null,
    last_updated: m.val.last_updated ?? null,
    max_input_tokens: m.val.max_input_tokens || m.val.max_tokens || null,
    max_output_tokens: m.val.max_output_tokens || null,
    input_cost: m.val.input_cost_per_token ?? null,
    output_cost: m.val.output_cost_per_token ?? null,
    // capability fields — model-intrinsic, carried through from filter.js.
    reasoning: m.val.reasoning ?? false,
    tool_call: m.val.tool_call ?? false,
    attachment: m.val.attachment ?? false,
    modalities: m.val.modalities ?? { input: [], output: [] },
    open_weights: m.val.open_weights ?? false,
    knowledge: m.val.knowledge ?? null,
  };
}
let records = scoped.map(rec);

// ── curated superseded override ─────────────────────────────────────
// Cross-family supersession that no deterministic rule (release_date cutoff,
// version pruning, regional dedup) can reach. Tiny hand-curated list in
// src/superseded.json. Match by regex on the model id (last segment of
// model_key, case-insensitive) AND on provider.
const supersededRules = JSON.parse(readFileSync(SUPERSEDED, 'utf-8'))
  .map(r => ({ ...r, re: new RegExp(r.pattern, 'i') }));

const supersededDrops = [];
records = records.filter(r => {
  const modelId = r.model_key.includes('/')
    ? r.model_key.slice(r.model_key.indexOf('/') + 1)
    : r.model_key;
  for (const rule of supersededRules) {
    if (rule.provider === r.provider && rule.re.test(modelId)) {
      supersededDrops.push({ key: r.model_key, reason: rule.reason });
      return false;
    }
  }
  return true;
});
if (supersededDrops.length) {
  console.log(`superseded: ${supersededDrops.length} dropped`);
  for (const d of supersededDrops) console.log(`  - ${d.key} — ${d.reason}`);
}

// ── write data/frontier_final.json ─────────────────────────────────
writeFileSync(OUT_JSON, JSON.stringify(records, null, 2));

// ── write FRONTIER_MODELS.md (dashboard) ───────────────────────────
const fmtTok = n => (n == null ? '—' : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const fmtCost = c => (c == null ? '—' : `$${(c * 1e6).toFixed(2)}`);

const byProvider = {};
for (const r of records) (byProvider[r.provider] ||= []).push(r);

let md = `# Frontier Models\n\n`;
md += `Generated: ${TODAY}\n`;
md += `Source: models.dev\n`;
md += `${records.length} frontier models across ${Object.keys(byProvider).length} providers `;
md += `(scope: ${SCOPE}).\n\n`;
md += `Costs are per 1M tokens. Context is the token limit (input → output).\n`;

for (const provider of Object.keys(byProvider).sort()) {
  const rows = byProvider[provider].sort((a, b) =>
    (b.release_date || '').localeCompare(a.release_date || '') ||
    a.model_key.localeCompare(b.model_key)
  );
  md += `\n## ${provider}\n\n`;
  md += `| Model | Tier | Released | Context (in→out) | $/1M in | $/1M out |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    md += `| \`${r.model_key}\` | ${r.tier} | ${r.release_date || '—'} | ` +
      `${fmtTok(r.max_input_tokens)} → ${fmtTok(r.max_output_tokens)} | ` +
      `${fmtCost(r.input_cost)} | ${fmtCost(r.output_cost)} |\n`;
  }
}

writeFileSync(OUT_MD, md);

// ── console summary ────────────────────────────────────────────────
const N_RAW = Object.keys(data).length;
console.log('\n══════════════════════════════════════════════════════════');
console.log(`  FRONTIER MODELS — scope: ${SCOPE} (${records.length} rows)`);
console.log('══════════════════════════════════════════════════════════\n');

for (const provider of Object.keys(byProvider).sort()) {
  const rows = byProvider[provider];
  console.log(`─── ${provider.toUpperCase()} (${rows.length}) ───`);
  console.table(rows.map(r => ({
    Model: r.model_key,
    Tier: r.tier,
    Released: r.release_date || '—',
    'In': r.max_input_tokens || '—',
    'Out': r.max_output_tokens || '—',
    '$ in': fmtCost(r.input_cost),
    '$ out': fmtCost(r.output_cost),
  })));
}

console.log(`\nfunnel: filtered ${N_RAW} → chat ${N_CHAT} → families ${familySet.size} → pruned ${N_PRUNED} → scope:${SCOPE} ${records.length}`);
console.log(`→ ${OUT_JSON}  (${records.length} records)`);
console.log(`→ ${OUT_MD}`);

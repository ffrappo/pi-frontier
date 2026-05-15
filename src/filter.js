#!/usr/bin/env node
// filter.js — flatten the models.dev catalog and apply the release_date-first cut.
//
// models.dev is provider-keyed: { providerId: { models: { modelId: {...} } } }.
//
// This stage:
//  1. Flattens provider → models into a flat list, tagging each with provider.
//  2. Builds a CLEAN single key (no double provider prefix — see below).
//  3. PRIMARY FILTER: drop models whose `release_date` is older than
//     MONTHS_THRESHOLD months. Missing release_date → survives.
//     This single cut removes ~64% of the dump and all the legacy junk —
//     no legacy-name regex needed.
//  4. Drops non-chat modalities (image/audio/video/embedding-only).
//  5. Normalizes fields to the shape frontier.js expects, carrying through
//     BOTH release_date and last_updated.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN  = join(__dirname, '..', 'data', 'raw_models.json');
const OUT = join(__dirname, '..', 'data', 'filtered_models.json');

const MONTHS_THRESHOLD = parseInt(process.env.MONTHS_THRESHOLD || '6', 10);
// Family-head rescue grace window. A pre-cutoff model that is the newest of its
// family is rescued ONLY if it's still within this wider window — that keeps
// live slow-cadence models (claude-haiku-4-5, ~7mo) while still dropping truly
// abandoned family heads (o3-pro ~11mo, o4-mini ~13mo). See _tmp/release_filter_eval.md.
const RESCUE_MONTHS = parseInt(process.env.RESCUE_MONTHS || '8', 10);
const now = new Date();
const CUTOFF = new Date(now.getFullYear(), now.getMonth() - MONTHS_THRESHOLD, now.getDate());
const RESCUE_CUTOFF = new Date(now.getFullYear(), now.getMonth() - RESCUE_MONTHS, now.getDate());

// Build a clean single key. Many models.dev entries are keyed by aggregators
// (openrouter, nvidia, …) with the model id ALREADY carrying a vendor segment,
// e.g. providerId="openrouter", modelId="anthropic/claude-opus-4-7", or
// providerId="nvidia", modelId="nvidia/nemotron-…". Naively doing
// `${providerId}/${modelId}` yields the double-prefix bug
// (`nvidia/nvidia/nemotron`, `alibaba/alibaba/qwen3.6-…`). Fix: take the bare
// model id (last path segment family kept intact) and prefix the provider once.
function cleanKey(providerId, modelId) {
  let bare = modelId;
  // strip a leading "<providerId>/" if the id repeats its own provider
  if (bare.toLowerCase().startsWith(providerId.toLowerCase() + '/')) {
    bare = bare.slice(providerId.length + 1);
  }
  // strip any remaining leading vendor segment(s) so the key is provider + id
  // only (the original vendor is already captured by providerId).
  while (/^[a-z0-9._-]+\//i.test(bare)) bare = bare.replace(/^[a-z0-9._-]+\//i, '');
  return `${providerId}/${bare}`;
}

// ── main ───────────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(IN, 'utf-8'));

// keep-newest-in-family pre-pass: a hard date cutoff wrongly kills a
// slow-cadence family's only live model (e.g. claude-haiku-4-5 — no Haiku
// successor shipped). So before cutting, find the newest-dated member of every
// provider::family group; that member is always kept even if it's pre-cutoff.
const familyNewest = new Map(); // "providerId::family" → newest release_date
for (const [providerId, provider] of Object.entries(data)) {
  const models = provider && provider.models;
  if (!models || typeof models !== 'object') continue;
  for (const m of Object.values(models)) {
    if (!m || typeof m !== 'object' || !m.family || !m.release_date) continue;
    const fk = `${providerId}::${m.family}`;
    const cur = familyNewest.get(fk);
    if (!cur || m.release_date > cur) familyNewest.set(fk, m.release_date);
  }
}

let total = 0, droppedModality = 0, droppedOld = 0, rescuedNewest = 0;
const kept = {};

for (const [providerId, provider] of Object.entries(data)) {
  const models = provider && provider.models;
  if (!models || typeof models !== 'object') continue;

  for (const [modelId, m] of Object.entries(models)) {
    if (!m || typeof m !== 'object') continue;
    total++;

    // ── PRIMARY FILTER: release_date staleness cut. Missing date → survives.
    // Exception: the newest-dated member of a family is always kept, even if
    // pre-cutoff, so a family is never silently erased (keep-newest-in-family).
    if (m.release_date) {
      const d = new Date(m.release_date);
      if (!isNaN(d) && d < CUTOFF) {
        const isFamilyHead = m.family &&
          familyNewest.get(`${providerId}::${m.family}`) === m.release_date;
        // rescue only a live family head — still within the wider grace window.
        if (!isFamilyHead || d < RESCUE_CUTOFF) { droppedOld++; continue; }
        rescuedNewest++;
      }
    }

    // ── modality filter: a chat model emits text. Drop image/audio/video-only
    // and embedding/rerank models.
    const out = (m.modalities && m.modalities.output) || ['text'];
    if (!out.includes('text')) { droppedModality++; continue; }
    if (/\b(embed|embedding|rerank|reranker)\b/i.test(modelId)) { droppedModality++; continue; }

    // ── normalize to the downstream shape ──────────────────────────
    // models.dev cost is USD per 1M tokens → store per-token (÷ 1e6).
    // cost can be entirely absent (open-weight models) → leave null.
    const cost = m.cost || {};
    const perTok = v => (typeof v === 'number' ? v / 1e6 : null);

    const key = cleanKey(providerId, modelId);
    kept[key] = {
      model_id: m.id || modelId,
      litellm_provider: providerId,        // name kept for downstream compat
      family: m.family || null,
      release_date: m.release_date || null,
      last_updated: m.last_updated || null,
      max_input_tokens: (m.limit && m.limit.context) ?? null,
      max_output_tokens: (m.limit && m.limit.output) ?? null,
      input_cost_per_token: perTok(cost.input),
      output_cost_per_token: perTok(cost.output),
      // capability fields propagated end-to-end (model-intrinsic properties)
      reasoning: m.reasoning ?? false,
      tool_call: m.tool_call ?? false,
      attachment: m.attachment ?? false,
      modalities: m.modalities && typeof m.modalities === 'object'
        ? {
            input: Array.isArray(m.modalities.input) ? m.modalities.input : [],
            output: Array.isArray(m.modalities.output) ? m.modalities.output : [],
          }
        : { input: [], output: [] },
      open_weights: m.open_weights ?? false,
      knowledge: m.knowledge ?? null,
      mode: 'chat',
    };
  }
}

writeFileSync(OUT, JSON.stringify(kept, null, 2));

console.log(`Total models:    ${total}`);
console.log(`  release-old:   ${droppedOld}  (release_date < ${CUTOFF.toISOString().slice(0, 10)})`);
console.log(`  non-chat:      ${droppedModality}`);
console.log(`  rescued (family head, pre-cutoff): ${rescuedNewest}`);
console.log(`  ─────────────────────`);
console.log(`  kept:          ${Object.keys(kept).length}`);
console.log(`Cutoff: ${CUTOFF.toISOString().slice(0, 10)} (${MONTHS_THRESHOLD} months ago)`);
console.log(`→ ${OUT}`);

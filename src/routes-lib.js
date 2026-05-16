// routes-lib.js — shared route scanning + capability filtering helpers
// used by src/where.js and src/routes.js.
//
// The frontier list (data/frontier_final.json) holds the canonical curated models. The
// raw dump (data/raw_models.json) lists ~4500 entries — every reseller copy,
// cloud mirror, and aggregator variant. A "route" here is one provider's hosted
// copy of a frontier model. We map frontier → routes by matching the LAST
// path-segment of the model id (case-insensitive). That correctly captures the
// same model id under aggregator prefixes (`openrouter/z-ai/glm-5-turbo`,
// `kilo/zai/glm-5-turbo`) without misfiring on strict variants like
// `glm-5-turbo-fp8`.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Same name-based block we use in filter.js / frontier.js for non-chat
// modalities. Keeps embedding/image/audio variants from polluting route tables
// just because the trailing name segment matches a chat model.
const NON_CHAT_NAME_RE = /\b(embed|embedding|rerank|reranker)\b/i;
const MODAL_BLOCK_RE = /(?:audio|realtime|tts|-search-api|search-preview|robotics|lyria|image|whisper|transcribe|moderation|guard|computer-use)/i;

function isChatModality(m, modelId) {
  const out = (m.modalities && m.modalities.output) || ['text'];
  if (!out.includes('text')) return false;
  if (NON_CHAT_NAME_RE.test(modelId)) return false;
  if (MODAL_BLOCK_RE.test(modelId)) return false;
  return true;
}

// Last-segment-after-slash, lowercased — the unit we match on.
export function lastSegment(modelId) {
  const idx = modelId.lastIndexOf('/');
  return (idx >= 0 ? modelId.slice(idx + 1) : modelId).toLowerCase();
}

export function loadFrontier() {
  return JSON.parse(readFileSync(join(DATA_DIR, 'frontier_final.json'), 'utf-8'));
}

export function loadRaw() {
  return JSON.parse(readFileSync(join(DATA_DIR, 'raw_models.json'), 'utf-8'));
}

// Build a flat index of every chat-modality entry in the raw dump, keyed by
// last-segment for O(1) lookup. One pass, reusable across all frontier models.
//   { 'glm-5-turbo': [ { provider, modelId, input_cost, output_cost,
//                        max_input_tokens, max_output_tokens }, ... ] }
// Costs are PER 1M TOKENS (raw dump's native unit — kept as-is for routes).
export function buildRouteIndex(raw) {
  const idx = new Map();
  for (const [providerId, provider] of Object.entries(raw)) {
    const models = provider && provider.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelId, m] of Object.entries(models)) {
      if (!m || typeof m !== 'object') continue;
      if (!isChatModality(m, modelId)) continue;
      const cost = m.cost || {};
      const limit = m.limit || {};
      const entry = {
        provider: providerId,
        model_key: `${providerId}/${modelId}`,
        // route id (the raw id used by the reseller) — useful for routing tools
        model_id: modelId,
        input_cost: typeof cost.input === 'number' ? cost.input : null,
        output_cost: typeof cost.output === 'number' ? cost.output : null,
        max_input_tokens: limit.context ?? null,
        max_output_tokens: limit.output ?? null,
      };
      const seg = lastSegment(modelId);
      if (!idx.has(seg)) idx.set(seg, []);
      idx.get(seg).push(entry);
    }
  }
  return idx;
}

// Return all routes for a single frontier model — exact last-segment match.
// `nullsLast: true` puts entries with no cost at the end (rare — usually
// open-weight providers that don't quote pricing).
export function routesForFrontier(frontier, routeIndex) {
  const seg = lastSegment(frontier.model_key);
  const hits = routeIndex.get(seg) || [];
  return [...hits].sort((a, b) => {
    const ai = a.input_cost, bi = b.input_cost;
    if (ai == null && bi == null) return a.provider.localeCompare(b.provider);
    if (ai == null) return 1;
    if (bi == null) return -1;
    if (ai !== bi) return ai - bi;
    return a.provider.localeCompare(b.provider);
  });
}

// Substring match on last segment, case-insensitive — the rule the task spec
// defines. `glm-5-turbo` matches `zai/glm-5-turbo` but NOT `glm-5-turbo-fp8`
// when called with the full target (`glm-5-turbo-fp8` would be a different
// last-segment). Here we use SUBSTRING for the user-facing pattern, since the
// CLI accepts loose patterns like `gpt-5` or `MiniMax`.
export function matchFrontier(frontier, pattern) {
  if (!pattern) return frontier;
  const p = pattern.toLowerCase();
  return frontier.filter(f => lastSegment(f.model_key).includes(p));
}

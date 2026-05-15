// pi-frontier — programmatic entry point.
//
// Two layers exported here:
//   1. Kernel re-exports from routes-lib.js — building blocks used by the CLI
//      and routes generator. Stable, low-level.
//   2. Convenience accessors that read the bundled JSON snapshots and offer
//      single-call helpers for the most common questions:
//         - "give me the 44 frontier models"
//         - "where can I run <name> and what's the cheapest route?"
//         - "give me everything that reasons + does tools + has 200k+ context"
//
// Data is bundled (synchronous readFileSync at import time) so a consumer can
// `import { getFrontierModels } from 'pi-frontier'` and immediately have the
// daily snapshot in hand — no network call, no awaits.
//
// Costs in `frontier_final.json` are PER TOKEN (USD). The route entries are
// PER 1M TOKENS (raw catalog's native unit). filterCapability's max-cost
// constraints take $/1M for human-friendly input and convert internally.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  lastSegment,
  loadFrontier,
  loadRaw,
  buildRouteIndex,
  routesForFrontier,
  matchFrontier,
} from './routes-lib.js';

// ── kernel re-exports ─────────────────────────────────────────────
export {
  lastSegment,
  loadFrontier,
  loadRaw,
  buildRouteIndex,
  routesForFrontier,
  matchFrontier,
};

// ── bundled JSON (read once, frozen on first access) ──────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

let _frontier = null;
let _routes = null;

function readJSON(name) {
  return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf-8'));
}

/**
 * Returns the 44-model frontier_final.json array.
 * Same data as the CLI's `where` list view. Costs are PER TOKEN.
 */
export function getFrontierModels() {
  if (!_frontier) _frontier = readJSON('frontier_final.json');
  return _frontier;
}

/**
 * Returns the full routes.json document:
 *   { generated: "YYYY-MM-DD", models: { "<key>": { frontier, routes[] } } }
 * Routes are sorted by input_cost ascending (nulls last). Route costs are
 * USD per 1M tokens.
 */
export function getRoutes() {
  if (!_routes) _routes = readJSON('routes.json');
  return _routes;
}

/**
 * The generation date (ISO YYYY-MM-DD) of the bundled snapshot.
 * Matches what the daily-rebuild action stamps into routes.json.
 */
export function getGeneratedAt() {
  return getRoutes().generated;
}

// ── lookup helpers ────────────────────────────────────────────────

/**
 * Find every frontier model whose last-path-segment contains `name`
 * (case-insensitive substring). Same match rule as the CLI.
 *   findRoutes('glm-5-turbo') → matches zai/glm-5-turbo
 *   findRoutes('gpt-5')       → all gpt-5* frontier models
 * Returns an array of { frontier, routes[] } objects (routes sorted by cost).
 * Empty array if nothing matches.
 */
export function findRoutes(name) {
  if (!name) return [];
  const routes = getRoutes();
  const needle = String(name).toLowerCase();
  const out = [];
  for (const [key, entry] of Object.entries(routes.models)) {
    if (lastSegment(key).includes(needle)) out.push(entry);
  }
  return out;
}

/**
 * Shortcut: return the single cheapest non-null-priced route for the best
 * match of `name`. Returns null if no match or every route lacks an input cost.
 * The route object is the same shape used in routes.json (input/output_cost in
 * $ per 1M tokens, model_key fully-qualified e.g. `openrouter/z-ai/glm-5-turbo`).
 */
export function cheapestRoute(name) {
  const matches = findRoutes(name);
  let cheapest = null;
  for (const m of matches) {
    for (const r of m.routes) {
      if (r.input_cost == null) continue;
      if (!cheapest || r.input_cost < cheapest.input_cost) cheapest = r;
    }
  }
  return cheapest;
}

/**
 * Find the frontier model entry/entries matching `name` (same substring rule).
 * Returns frontier_final.json shape entries. Empty array if nothing matches.
 */
export function findModel(name) {
  if (!name) return [];
  const needle = String(name).toLowerCase();
  return getFrontierModels().filter(m => lastSegment(m.model_key).includes(needle));
}

// ── capability filter ─────────────────────────────────────────────
// Mirrors the CLI's flag semantics. Every key is optional. Cost caps take
// $/1M (human-friendly); frontier entries store costs per-token internally,
// so we multiply by 1e6 to compare. Open-weight models with null cost FAIL
// any explicit cost cap (unknown ≠ within budget — same rule as the CLI).

/**
 * @typedef {Object} CapabilityFilter
 * @property {boolean} [reasoning]      require reasoning support
 * @property {boolean} [tools]          require tool calling (maps to tool_call)
 * @property {boolean} [attachment]     require file-attachment support
 * @property {boolean} [vision]         modalities.input includes 'image'
 * @property {boolean} [audio]          modalities.input includes 'audio'
 * @property {boolean} [openWeights]    require open weights
 * @property {number}  [minContext]     min max_input_tokens
 * @property {number}  [maxInputCost]   max input cost in $/1M tokens
 * @property {number}  [maxOutputCost]  max output cost in $/1M tokens
 */

/**
 * Filter the frontier list by intrinsic model capabilities + numeric caps.
 * Returns a new array of frontier entries that pass every constraint.
 * @param {CapabilityFilter} [f]
 */
export function filterCapability(f = {}) {
  const models = getFrontierModels();
  return models.filter(m => {
    if (f.reasoning  && !m.reasoning)  return false;
    if (f.tools      && !m.tool_call)  return false;
    if (f.attachment && !m.attachment) return false;
    if (f.openWeights && !m.open_weights) return false;

    const inputs = (m.modalities && m.modalities.input) || [];
    if (f.vision && !inputs.includes('image')) return false;
    if (f.audio  && !inputs.includes('audio')) return false;

    if (f.minContext != null) {
      if ((m.max_input_tokens ?? 0) < f.minContext) return false;
    }
    if (f.maxInputCost != null) {
      if (m.input_cost == null) return false;
      if (m.input_cost * 1e6 > f.maxInputCost) return false;
    }
    if (f.maxOutputCost != null) {
      if (m.output_cost == null) return false;
      if (m.output_cost * 1e6 > f.maxOutputCost) return false;
    }
    return true;
  });
}

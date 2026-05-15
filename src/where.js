#!/usr/bin/env node
// where.js — provider route lookup + capability filter CLI.
//
//   node src/where.js                    list all 44 frontier models
//   node src/where.js glm-5-turbo        show frontier match + route table
//   node src/where.js --reasoning --tools --min-context 200000
//   node src/where.js --vision           image-input capable
//   node src/where.js gpt-5.5 --json     machine-readable
//
// Match rule: last-segment-after-slash, case-insensitive substring. So
// `glm-5-turbo` matches `zai/glm-5-turbo`, `openrouter/z-ai/glm-5-turbo`, etc.,
// but NOT `glm-5-turbo-fp8` (different last segment).
//
// Routes (the reseller copies) are scanned from data/raw_models.json by the
// same last-segment rule. Costs in route tables are USD per 1M tokens (the
// raw-dump native unit). Costs on the frontier list are stored per-token —
// where.js converts on display for human readability.

import { parseArgs } from 'util';
import {
  loadFrontier,
  loadRaw,
  buildRouteIndex,
  routesForFrontier,
  matchFrontier,
} from './routes-lib.js';

// ── arg parsing ────────────────────────────────────────────────────
// All flags are boolean OR string. The optional positional pattern is the
// first non-flag arg; we use `allowPositionals` and grab args[0].
const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    // capability filters (all boolean — negative forms below)
    'reasoning':       { type: 'boolean' },
    'no-reasoning':    { type: 'boolean' },
    'tools':           { type: 'boolean' },
    'no-tools':        { type: 'boolean' },
    'attachment':      { type: 'boolean' },
    'no-attachment':   { type: 'boolean' },
    'vision':          { type: 'boolean' },
    'audio':           { type: 'boolean' },
    'open-weights':    { type: 'boolean' },
    'no-open-weights': { type: 'boolean' },
    // numeric constraints
    'min-context':     { type: 'string' },
    'max-input-cost':  { type: 'string' },
    'max-output-cost': { type: 'string' },
    // output mode
    'routes':          { type: 'boolean' },
    'json':            { type: 'boolean' },
    'help':            { type: 'boolean', short: 'h' },
  },
});

if (flags.help) {
  console.log(`Usage: node src/where.js [pattern] [flags]

  pattern               substring match on the last segment of the model id
                        (case-insensitive). e.g. 'glm-5-turbo', 'gpt-5', 'minimax'

Capability filters (model-intrinsic, from frontier_final.json):
  --reasoning / --no-reasoning
  --tools / --no-tools                 (maps to tool_call)
  --attachment / --no-attachment
  --vision                             modalities.input includes 'image'
  --audio                              modalities.input includes 'audio'
  --open-weights / --no-open-weights

Constraints:
  --min-context <tokens>               e.g. 200000
  --max-input-cost <usd-per-1m>        e.g. 5
  --max-output-cost <usd-per-1m>

Output:
  --routes                             force route view (per-model route table)
  --json                               JSON instead of aligned text table
  -h, --help                           this message
`);
  process.exit(0);
}

const pattern = positionals[0] || null;

// ── apply capability filters ───────────────────────────────────────
// frontier_final cost fields are PER TOKEN; user supplies $/1M, so we
// compare in $/1M units (× 1e6) to keep the flag UX human.

function passesCapabilities(m) {
  if (flags['reasoning']      && !m.reasoning)              return false;
  if (flags['no-reasoning']   &&  m.reasoning)              return false;
  if (flags['tools']          && !m.tool_call)              return false;
  if (flags['no-tools']       &&  m.tool_call)              return false;
  if (flags['attachment']     && !m.attachment)             return false;
  if (flags['no-attachment']  &&  m.attachment)             return false;
  if (flags['open-weights']   && !m.open_weights)           return false;
  if (flags['no-open-weights'] && m.open_weights)           return false;

  const inputs = (m.modalities && m.modalities.input) || [];
  if (flags['vision'] && !inputs.includes('image'))         return false;
  if (flags['audio']  && !inputs.includes('audio'))         return false;

  if (flags['min-context'] != null) {
    const min = Number(flags['min-context']);
    if (!Number.isFinite(min)) {
      console.error(`Invalid --min-context: ${flags['min-context']}`);
      process.exit(1);
    }
    if ((m.max_input_tokens ?? 0) < min) return false;
  }
  if (flags['max-input-cost'] != null) {
    const cap = Number(flags['max-input-cost']);
    if (!Number.isFinite(cap)) {
      console.error(`Invalid --max-input-cost: ${flags['max-input-cost']}`);
      process.exit(1);
    }
    // models with null cost (open-weight) fail an explicit cost cap — the user
    // is asking for a price ceiling, and unknown price ≠ within budget.
    if (m.input_cost == null) return false;
    if (m.input_cost * 1e6 > cap) return false;
  }
  if (flags['max-output-cost'] != null) {
    const cap = Number(flags['max-output-cost']);
    if (!Number.isFinite(cap)) {
      console.error(`Invalid --max-output-cost: ${flags['max-output-cost']}`);
      process.exit(1);
    }
    if (m.output_cost == null) return false;
    if (m.output_cost * 1e6 > cap) return false;
  }
  return true;
}

// ── formatting ─────────────────────────────────────────────────────
function fmtTok(n) {
  if (n == null) return '—';
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
function fmtPerTok(c) { return c == null ? '—' : `$${(c * 1e6).toFixed(2)}`; }
function fmtPerMil(c) { return c == null ? '—' : `$${Number(c).toFixed(2)}`; }
function fmtBool(b) { return b ? 'yes' : 'no'; }
function fmtMods(mods) {
  const i = (mods && mods.input) || [];
  const o = (mods && mods.output) || [];
  return `${i.join('+') || '—'}→${o.join('+') || '—'}`;
}

// Render a column-aligned plain-text table. headers: string[], rows: string[][]
function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? '').length))
  );
  const pad = (s, w) => (s ?? '').padEnd(w);
  const head = headers.map((h, i) => pad(h, widths[i])).join('  ');
  const rule = widths.map(w => '─'.repeat(w)).join('  ');
  const body = rows.map(r => r.map((c, i) => pad(c, widths[i])).join('  ')).join('\n');
  return `${head}\n${rule}\n${body}`;
}

// ── load + match ───────────────────────────────────────────────────
const frontier = loadFrontier();

let matched = matchFrontier(frontier, pattern).filter(passesCapabilities);

// ── route view? Triggered by a pattern OR --routes. Otherwise list view. ──
const wantRoutes = !!pattern || flags.routes;

if (flags.json) {
  if (wantRoutes) {
    const raw = loadRaw();
    const idx = buildRouteIndex(raw);
    const out = matched.map(m => ({
      frontier: m,
      routes: routesForFrontier(m, idx),
    }));
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(JSON.stringify(matched, null, 2));
  }
  process.exit(0);
}

if (!matched.length) {
  console.error('No frontier models matched.');
  process.exit(1);
}

// ── list view ──────────────────────────────────────────────────────
if (!wantRoutes) {
  const rows = matched.map(m => [
    m.model_key,
    m.tier,
    m.release_date || '—',
    `${fmtTok(m.max_input_tokens)}→${fmtTok(m.max_output_tokens)}`,
    fmtPerTok(m.input_cost),
    fmtPerTok(m.output_cost),
    fmtBool(m.reasoning),
    fmtBool(m.tool_call),
    fmtBool(m.attachment),
    fmtMods(m.modalities),
    fmtBool(m.open_weights),
  ]);
  const headers = [
    'Model', 'Tier', 'Released', 'Context', '$/1M in', '$/1M out',
    'Reason', 'Tools', 'Attach', 'Modalities', 'Open',
  ];
  console.log(table(headers, rows));
  console.log(`\n${matched.length} model${matched.length === 1 ? '' : 's'}.`);
  process.exit(0);
}

// ── route view ─────────────────────────────────────────────────────
const raw = loadRaw();
const idx = buildRouteIndex(raw);

for (let i = 0; i < matched.length; i++) {
  const m = matched[i];
  if (i > 0) console.log('');
  console.log(`══ ${m.model_key}  (${m.tier}, released ${m.release_date || '—'})`);
  console.log(`   context ${fmtTok(m.max_input_tokens)}→${fmtTok(m.max_output_tokens)}  ·  reasoning:${fmtBool(m.reasoning)}  tools:${fmtBool(m.tool_call)}  attach:${fmtBool(m.attachment)}  open:${fmtBool(m.open_weights)}`);
  console.log(`   modalities ${fmtMods(m.modalities)}${m.knowledge ? `  ·  knowledge ${m.knowledge}` : ''}`);

  const routes = routesForFrontier(m, idx);
  if (!routes.length) {
    console.log(`   (no routes in raw catalog)`);
    continue;
  }
  // Find cheapest by input cost for the ★ marker; ignore null-cost entries.
  let cheapest = null;
  for (const r of routes) {
    if (r.input_cost == null) continue;
    if (!cheapest || r.input_cost < cheapest.input_cost) cheapest = r;
  }
  const rows = routes.map(r => [
    r === cheapest ? '★' : ' ',
    r.provider,
    r.model_id,
    fmtPerMil(r.input_cost),
    fmtPerMil(r.output_cost),
    `${fmtTok(r.max_input_tokens)}→${fmtTok(r.max_output_tokens)}`,
  ]);
  const headers = [' ', 'Provider', 'Model key', '$/1M in', '$/1M out', 'Context'];
  console.log(table(headers, rows));
}

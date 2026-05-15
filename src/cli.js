#!/usr/bin/env node
// cli.js — `pi-frontier` command. Provider-route lookup + capability filter
// on top of the bundled frontier_final.json + raw_models.json snapshot.
//
//   pi-frontier                       list all frontier models
//   pi-frontier glm-5-turbo           frontier match + route table
//   pi-frontier --reasoning --tools --min-context 200000
//   pi-frontier --vision              image-input capable
//   pi-frontier gpt-5.5 --json        machine-readable
//
// Match rule: last-segment-after-slash, case-insensitive substring. So
// `glm-5-turbo` matches `zai/glm-5-turbo`, `openrouter/z-ai/glm-5-turbo`, etc.,
// but NOT `glm-5-turbo-fp8` (different last segment).
//
// Costs in the route table are USD per 1M tokens (raw catalog native unit).
// Costs on the frontier list are stored per-token — we convert on display.

import { parseArgs } from 'util';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getRoutes,
  loadRaw,
  buildRouteIndex,
  routesForFrontier,
  matchFrontier,
  filterCapability,
} from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_PATH = join(__dirname, '..', 'data', 'raw_models.json');

// Use raw_models.json when present (development checkout), otherwise fall back
// to the precomputed routes.json snapshot (shipped in the npm tarball). Both
// paths produce the same route table; only the development one can rebuild
// from scratch via `npm run all`.
function routeLookup() {
  if (existsSync(RAW_PATH)) {
    const idx = buildRouteIndex(loadRaw());
    return m => routesForFrontier(m, idx);
  }
  const routes = getRoutes();
  return m => (routes.models[m.model_key]?.routes) || [];
}

// ── arg parsing ────────────────────────────────────────────────────
const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
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
    'min-context':     { type: 'string' },
    'max-input-cost':  { type: 'string' },
    'max-output-cost': { type: 'string' },
    'routes':          { type: 'boolean' },
    'json':            { type: 'boolean' },
    'help':            { type: 'boolean', short: 'h' },
  },
});

if (flags.help) {
  console.log(`Usage: pi-frontier [pattern] [flags]

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

// ── numeric flag parsing (with sane error messages) ────────────────
function numericFlag(name) {
  if (flags[name] == null) return undefined;
  const n = Number(flags[name]);
  if (!Number.isFinite(n)) {
    console.error(`Invalid --${name}: ${flags[name]}`);
    process.exit(1);
  }
  return n;
}

// Use index.js's filterCapability for the positive side; handle negative flags
// (--no-reasoning etc.) inline since the library only exposes positive
// constraints (the lib is the canonical, headed-UI-friendly API surface).
function applyNegativeFlags(list) {
  return list.filter(m => {
    if (flags['no-reasoning']    &&  m.reasoning)    return false;
    if (flags['no-tools']        &&  m.tool_call)    return false;
    if (flags['no-attachment']   &&  m.attachment)   return false;
    if (flags['no-open-weights'] &&  m.open_weights) return false;
    return true;
  });
}

const capFiltered = filterCapability({
  reasoning:      flags['reasoning']      || undefined,
  tools:          flags['tools']          || undefined,
  attachment:     flags['attachment']     || undefined,
  vision:         flags['vision']         || undefined,
  audio:          flags['audio']          || undefined,
  openWeights:    flags['open-weights']   || undefined,
  minContext:     numericFlag('min-context'),
  maxInputCost:   numericFlag('max-input-cost'),
  maxOutputCost:  numericFlag('max-output-cost'),
});

let matched = applyNegativeFlags(matchFrontier(capFiltered, pattern));

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

// ── route view? Triggered by a pattern OR --routes. Otherwise list view. ──
const wantRoutes = !!pattern || flags.routes;

if (flags.json) {
  if (wantRoutes) {
    const lookup = routeLookup();
    const out = matched.map(m => ({ frontier: m, routes: lookup(m) }));
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
const lookup = routeLookup();

for (let i = 0; i < matched.length; i++) {
  const m = matched[i];
  if (i > 0) console.log('');
  console.log(`══ ${m.model_key}  (${m.tier}, released ${m.release_date || '—'})`);
  console.log(`   context ${fmtTok(m.max_input_tokens)}→${fmtTok(m.max_output_tokens)}  ·  reasoning:${fmtBool(m.reasoning)}  tools:${fmtBool(m.tool_call)}  attach:${fmtBool(m.attachment)}  open:${fmtBool(m.open_weights)}`);
  console.log(`   modalities ${fmtMods(m.modalities)}${m.knowledge ? `  ·  knowledge ${m.knowledge}` : ''}`);

  const routes = lookup(m);
  if (!routes.length) {
    console.log(`   (no routes in raw catalog)`);
    continue;
  }
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

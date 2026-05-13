#!/usr/bin/env node
// filter.js — apply two filters to raw model list:
//  1. Drop any model that has a deprecation_date field (any value).
//  2. Drop models whose NAME contains a date older than MONTHS_THRESHOLD (default 6).

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN   = join(__dirname, '..', 'data', 'raw_models.json');
const OUT  = join(__dirname, '..', 'data', 'filtered_models.json');

const MONTHS_THRESHOLD = parseInt(process.env.MONTHS_THRESHOLD || '6', 10);
const now = new Date();
const CUTOFF = new Date(now.getFullYear(), now.getMonth() - MONTHS_THRESHOLD, now.getDate());

// ── helpers ────────────────────────────────────────────────────────
function extractDate(name) {
  // YYYY-MM-DD
  let m = name.match(/(20[12]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}`);
    if (!isNaN(d)) return d;
  }
  // YYYYMMDD
  m = name.match(/(20[12]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}`);
    if (!isNaN(d)) return d;
  }
  // YYYY-MM
  m = name.match(/(20[12]\d)-(0[1-9]|1[0-2])/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-01`);
    if (!isNaN(d)) return d;
  }
  return null;
}

// ── main ───────────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(IN, 'utf-8'));

let total = 0, droppedDep = 0, droppedOld = 0;
const kept = {};

for (const [key, val] of Object.entries(data)) {
  if (key === 'sample_spec' || typeof val !== 'object' || !val) continue;
  total++;

  // Filter 1: deprecation_date
  if (val.deprecation_date && val.deprecation_date !== '') { droppedDep++; continue; }

  // Filter 2: stale date in name
  const d = extractDate(key);
  if (d && d < CUTOFF) { droppedOld++; continue; }

  kept[key] = val;
}

writeFileSync(OUT, JSON.stringify(kept, null, 2));

console.log(`Total: ${total}  │  deprecated: ${droppedDep}  │  name-too-old: ${droppedOld}  │  kept: ${Object.keys(kept).length}`);
console.log(`Cutoff date: ${CUTOFF.toISOString().slice(0,10)} (${MONTHS_THRESHOLD} months ago)`);
console.log(`→ ${OUT}`);

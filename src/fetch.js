#!/usr/bin/env node
// fetch.js — download the latest models.dev catalog (provider-keyed, curated).

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL_SRC = 'https://models.dev/api.json';
const OUT = join(__dirname, '..', 'data', 'raw_models.json');

const res = await fetch(URL_SRC);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const data = await res.json();

writeFileSync(OUT, JSON.stringify(data, null, 2));

const providers = Object.keys(data).length;
let models = 0;
for (const p of Object.values(data)) models += Object.keys(p.models || {}).length;
console.log(`Fetched ${providers} providers, ${models} models → ${OUT}`);

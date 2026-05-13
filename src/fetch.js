#!/usr/bin/env node
// fetch.js — download latest LiteLLM model prices JSON

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL_SRC = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OUT = join(__dirname, '..', 'data', 'raw_models.json');

const res = await fetch(URL_SRC);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const data = await res.json();

writeFileSync(OUT, JSON.stringify(data, null, 2));
console.log(`Fetched ${Object.keys(data).length} entries → ${OUT}`);

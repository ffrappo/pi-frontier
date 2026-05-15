#!/usr/bin/env node
// routes.js — precompute the full sorted route table for every frontier model
// and write data/routes.json. Same matching rule as where.js (last-segment
// substring), same chat-modality filter on the raw dump.
//
// Output schema:
//   {
//     generated: "YYYY-MM-DD",
//     models: {
//       "<canonical_model_key>": {
//         frontier: { ...original frontier_final entry },
//         routes:   [ { provider, model_key, model_id, input_cost,
//                       output_cost, max_input_tokens, max_output_tokens } ]
//       }
//     }
//   }
// Routes are sorted by input_cost ascending (nulls last). Costs are per 1M.

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  loadFrontier,
  loadRaw,
  buildRouteIndex,
  routesForFrontier,
} from './routes-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'data', 'routes.json');
const TODAY = new Date().toISOString().slice(0, 10);

const frontier = loadFrontier();
const raw = loadRaw();
const idx = buildRouteIndex(raw);

const models = {};
let totalRoutes = 0;
let zeroRoute = 0;
for (const f of frontier) {
  const routes = routesForFrontier(f, idx);
  models[f.model_key] = { frontier: f, routes };
  totalRoutes += routes.length;
  if (!routes.length) zeroRoute++;
}

writeFileSync(OUT, JSON.stringify({ generated: TODAY, models }, null, 2));

console.log(`routes: ${frontier.length} frontier models → ${totalRoutes} routes (${zeroRoute} with no route hits)`);
console.log(`→ ${OUT}`);

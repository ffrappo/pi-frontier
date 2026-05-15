# pi-frontier

![pi-frontier banner](https://fcskjxapefiqdclrvbtw.supabase.co/storage/v1/object/public/assets/pi-packages/pi-frontier-banner.jpg)

A daily-rebuilt snapshot of the **frontier LLM landscape** — the latest model
per provider × family × tier (release-date-first, no AI in the loop) plus the
full **reseller route table** for each one. Comes as a JS library, a CLI, and
a static web UI.

Source: [models.dev](https://models.dev/api.json). Pipeline is purely
deterministic.

## Three ways to use it

### 1. Headless — `npm install pi-frontier`

```js
import {
  getFrontierModels,
  cheapestRoute,
  filterCapability,
  findRoutes,
  getGeneratedAt,
} from 'pi-frontier';

getFrontierModels();                          // → 44 frontier model objects
getGeneratedAt();                             // → "2026-05-15"

cheapestRoute('glm-5-turbo');
// → { provider: 'zai-coding-plan', model_key: 'zai-coding-plan/glm-5-turbo',
//     model_id: 'glm-5-turbo', input_cost: 0, output_cost: 0, ... }

filterCapability({ reasoning: true, tools: true, minContext: 200_000, maxInputCost: 5 });
// → array of frontier models matching every constraint

findRoutes('gpt-5.5');
// → [ { frontier: {...}, routes: [ {provider,model_id,$,...}, ... ] }, ... ]
```

The bundled snapshots are also directly importable:

```js
import frontier from 'pi-frontier/data/frontier';
import routes   from 'pi-frontier/data/routes';
```

Costs in `getFrontierModels()` entries are **per token** (USD). Routes use the
raw catalog's native unit: **per 1M tokens** (USD). `filterCapability` takes
its `maxInputCost` / `maxOutputCost` caps as **$/1M** for human-friendly input.

### 2. CLI — `npx pi-frontier`

```bash
npx pi-frontier                              # list all 44 frontier models
npx pi-frontier glm-5-turbo                  # frontier match + route table (★ = cheapest)
npx pi-frontier --reasoning --tools --min-context 200000
npx pi-frontier --vision --open-weights
npx pi-frontier gpt-5.5 --json               # machine-readable
```

Flags: `--reasoning` / `--no-reasoning`, `--tools` / `--no-tools` (maps to
`tool_call`), `--attachment` / `--no-attachment`, `--vision` (image input),
`--audio` (audio input), `--open-weights` / `--no-open-weights`.

Constraints: `--min-context <tokens>`, `--max-input-cost <usd-per-1m>`,
`--max-output-cost <usd-per-1m>`.

Output: `--routes` (force route view without a pattern), `--json`,
`-h` / `--help`.

### 3. Headed — [ffrappo.github.io/pi-frontier](https://ffrappo.github.io/pi-frontier/)

A single static page with the same filter logic. Filter by name, toggle
capability chips, drag the context / max-cost sliders, click a card to see
the full route table inline.

### 4. Raw JSON artifacts

Stable URLs anyone can fetch — no npm install, no API key, just `curl`:

| URL | Contents |
| --- | --- |
| `https://ffrappo.github.io/pi-frontier/data/frontier_final.json` | The 44-model frontier array |
| `https://ffrappo.github.io/pi-frontier/data/routes.json` | Per-model full route table |
| `https://ffrappo.github.io/pi-frontier/FRONTIER_MODELS.md` | Markdown dashboard |

```bash
curl -s https://ffrappo.github.io/pi-frontier/data/routes.json \
  | jq '.models["zai/glm-5-turbo"].routes[0]'
```

Both files are also pinned inside the npm tarball — `import 'pi-frontier/data/frontier'`
gives you a build-time-frozen copy if you'd rather not depend on Pages.

## How the snapshot is built

```bash
npm run all       # fetch → filter → frontier → routes
npm run fetch     # download the models.dev catalog
npm run filter    # flatten + release-date cutoff + normalize
npm run frontier  # dedup + prune + write final output
npm run routes    # precompute every frontier model's full route table
npm run where     # CLI lookup
```

### `filter.js` — release-date-first cut

The **primary filter** is a `release_date` cutoff: drop every model whose
`release_date` is older than `MONTHS_THRESHOLD` months (default 6). This single
cut removes ~64% of the dump and *all* the legacy junk (GPT-3.5, Llama 3.x,
Mixtral, o1, …) with no name regex and no AI. `release_date` is used — not
`last_updated`, which is polluted by reseller catalog re-indexing. Models with
no `release_date` survive (missing data is never grounds for dropping).

Also flattens the provider-keyed catalog to a clean single key (no double
provider prefix), drops non-chat modalities (image/audio/video/embedding-only),
and carries through both `release_date` and `last_updated`.

### `frontier.js` — dedup, prune, finalize

The release-date cutoff is orthogonal to deduplication, so this stage still:

- **Regional dedup** — collapses regional creator mirrors (`minimax-cn`,
  `moonshotai-cn`, `zhipuai`→`zai`) that re-list the same models; keeps the
  global / cheaper-priced entry.
- **Version-aware family pruning** — keeps the top version per
  provider × family × tier.
- **Keep newest in family** — guarantees every surviving family keeps its
  current head even if its `release_date` is >6 months old. This closes the one
  real false-negative: a slow-cadence model like `claude-haiku-4-5` (no Haiku
  successor shipped) would otherwise be wrongly aged out.

Writes `data/frontier_final.json` and the `FRONTIER_MODELS.md` dashboard. The
final record carries model-intrinsic capability fields too: `reasoning`,
`tool_call`, `attachment`, `modalities` (`{input, output}` arrays),
`open_weights`, `knowledge` (cutoff date).

`SCOPE` env var (default `creators`) restricts to `creators`, `creators+cloud`,
or `all` provider classes.

### `routes.js` — every reseller copy of every frontier model

The frontier list is canonical (44 first-party rows), but the same model is
typically also hosted under a dozen aggregators / clouds (`openrouter`,
`vercel`, `chutes`, `kilo`, `nano-gpt`, …). `routes.js` precomputes that view
into `data/routes.json`: for each frontier model, the full sorted route array
(by `input_cost` asc). Routes are matched by **last-segment-after-slash**
case-insensitive — so `glm-5-turbo` correctly collects `zai/glm-5-turbo`,
`openrouter/z-ai/glm-5-turbo`, `kilo/zai/glm-5-turbo`, etc., while still
ignoring strict variants like `glm-5-turbo-fp8` (different last segment).

## CI & freshness

- `.github/workflows/daily.yml` — runs the full pipeline at 03:17 UTC daily,
  commits if any of `frontier_final.json`, `routes.json`, or
  `FRONTIER_MODELS.md` changed.
- `.github/workflows/pages.yml` — every push to `main` redeploys the static
  UI + JSON artifacts to GitHub Pages.
- `.github/workflows/publish.yml` — pushing a `vMAJOR.MINOR.PATCH` tag
  publishes to npm with `prepublishOnly: npm run all`, so the tarball always
  ships a fresh snapshot.

## Limitations

The pipeline is only as current as models.dev. A brand-new model may not
appear here until models.dev adds it (PRs typically merge within days). If a
model is missing, check whether models.dev has it yet before assuming a
pipeline bug.

## Tuning

```bash
MONTHS_THRESHOLD=3 npm run filter   # tighter cutoff — only models <3 months old
SCOPE=creators+cloud npm run frontier
```

## License

MIT

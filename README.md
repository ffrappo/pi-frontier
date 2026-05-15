# pi-frontier

Fetch the [models.dev catalog](https://models.dev/api.json) and surface only the
**frontier** (latest) model per provider×family and per tier — using a
**release-date-first** filter. Pure deterministic pipeline, no AI stage.

The source is models.dev (`https://models.dev/api.json`) — a curated, no-auth,
provider-keyed catalog. Every first-party model maker has its own provider id,
and each model carries a real `release_date`, `limit.{context,output}`, and
`cost.{input,output}` (USD per 1M tokens; absent for open-weight models).

## Quickstart

```bash
npm run all       # fetch → filter → frontier → routes
npm run fetch     # download raw JSON
npm run filter    # flatten + release-date cutoff + normalize
npm run frontier  # dedup + prune + write final output
npm run routes    # precompute every frontier model's full route table
npm run where     # CLI lookup — see "Lookup" below
```

## How it works

### 1. `filter.js` — release-date-first cut

The **primary filter** is a `release_date` cutoff: drop every model whose
`release_date` is older than `MONTHS_THRESHOLD` months (default 6). This single
cut removes ~64% of the dump and *all* the legacy junk (GPT-3.5, Llama 3.x,
Mixtral, o1, …) with no name regex and no AI. `release_date` is used — not
`last_updated`, which is polluted by reseller catalog re-indexing. Models with
no `release_date` survive (missing data is never grounds for dropping).

Also flattens the provider-keyed catalog to a clean single key (no double
provider prefix), drops non-chat modalities (image/audio/video/embedding-only),
and carries through both `release_date` and `last_updated`.

### 2. `frontier.js` — dedup, prune, finalize

The release-date cutoff is orthogonal to deduplication, so this stage still:

- **Regional dedup** — collapses regional creator mirrors (`minimax-cn`,
  `moonshotai-cn`, `zhipuai`→`zai`) that re-list the same models; keeps the
  global / cheaper-priced entry.
- **Version-aware family pruning** — keeps the top version per
  provider×family×tier.
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

### 3. `routes.js` — every reseller copy of every frontier model

The frontier list is canonical (44 first-party rows), but the same model is
typically also hosted under a dozen aggregators / clouds (`openrouter`,
`vercel`, `chutes`, `kilo`, `nano-gpt`, …). `routes.js` precomputes that view
into `data/routes.json`: for each frontier model, the full sorted route array
(by `input_cost` asc). Routes are matched by **last-segment-after-slash**
case-insensitive — so `glm-5-turbo` correctly collects `zai/glm-5-turbo`,
`openrouter/z-ai/glm-5-turbo`, `kilo/zai/glm-5-turbo`, etc., while still
ignoring strict variants like `glm-5-turbo-fp8` (different last segment).

## Lookup (`npm run where`)

`src/where.js` is a small CLI on top of `frontier_final.json` + `raw_models.json`.
Same matching rule as routes.json. No deps — uses Node's `util.parseArgs`.

```bash
# All routes for glm-5-turbo, cheapest first (★ marks the cheapest):
node src/where.js glm-5-turbo

# List the frontier models that can reason AND call tools with ≥200K context:
node src/where.js --reasoning --tools --min-context 200000

# Open-weight, vision-capable models:
node src/where.js --vision --open-weights

# Machine-readable (JSON) — pipe into jq / scripts:
node src/where.js gpt-5.5 --json
```

Capability flags: `--reasoning` / `--no-reasoning`, `--tools` / `--no-tools`
(maps to `tool_call`), `--attachment` / `--no-attachment`, `--vision`
(image input), `--audio` (audio input), `--open-weights` /
`--no-open-weights`.

Constraints: `--min-context <tokens>`, `--max-input-cost <usd-per-1m>`,
`--max-output-cost <usd-per-1m>`.

Output: `--routes` (force route view without a pattern), `--json` (machine-readable).

## Limitations

The pipeline is only as current as models.dev. A brand-new model may not appear
here until models.dev adds it (PRs typically merge within days). If a model is
missing, check whether models.dev has it yet before assuming a pipeline bug.

## Tuning

```bash
MONTHS_THRESHOLD=3 npm run filter   # tighter cutoff — only models <3 months old
SCOPE=creators+cloud npm run frontier
```

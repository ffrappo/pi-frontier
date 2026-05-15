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
npm run all       # fetch → filter → frontier
npm run fetch     # download raw JSON
npm run filter    # flatten + release-date cutoff + normalize
npm run frontier  # dedup + prune + write final output
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

Writes `data/frontier_final.json` and the `FRONTIER_MODELS.md` dashboard.

`SCOPE` env var (default `creators`) restricts to `creators`, `creators+cloud`,
or `all` provider classes.

## Limitations

The pipeline is only as current as models.dev. A brand-new model may not appear
here until models.dev adds it (PRs typically merge within days). If a model is
missing, check whether models.dev has it yet before assuming a pipeline bug.

## Tuning

```bash
MONTHS_THRESHOLD=3 npm run filter   # tighter cutoff — only models <3 months old
SCOPE=creators+cloud npm run frontier
```

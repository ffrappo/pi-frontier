# pi-frontier

Fetch the [LiteLLM model prices JSON](https://github.com/BerriAI/litellm), strip stale/deprecated entries, then surface only the **frontier** (latest) model per provider×family and per tier.

## Quickstart

```bash
npm run all       # fetch → filter → frontier
npm run fetch     # download raw JSON
npm run filter    # apply deprecation + age filters
npm run frontier  # print frontier tables
```

## Filters applied

1. **Deprecation** — any model with a `deprecation_date` field is dropped.
2. **Stale-by-name** — models whose name contains a date older than 6 months (tunable via `MONTHS_THRESHOLD` env var) are dropped.

## Output

Two tables printed to stdout:

| Table | Description |
|-------|-------------|
| **Frontier** | One model per provider × family — highest version/date. |
| **Provider × Tier** | For each major provider, the frontier model per tier (pro, flash, mini, nano, lite, reasoning, etc.). |

## Tuning

```bash
MONTHS_THRESHOLD=3 npm run filter   # only drop models >3 months old
```

# Models page: analytics data and pre-aggregations

Status: implemented in the app, except the items marked "not built" below.
Sections 2 to 9 are the original design and are kept as the reasoning; where
the build differs from them, "What is implemented" wins.

This document says what data the Admin > Usage limits > Models views need
(grid with cost, footprint, usage and retirement columns; open row with a
usage distribution and cap replay; retirement runway; spend and popularity
map), what the app captures for them, and what still needs the analytics ETL.

## What is implemented

### The gap that had to be closed

Before this work the app could not supply the page. The usage counters
(`usageStore.ts`) exist only for cells that carry a cap: a request by a person
with no cap on a model writes nothing (`meteredCells` drops unlimited cells).
So the unlimited majority was invisible, and tokens were counted per person,
never per model. Popularity, percentiles and spend for an uncapped model could
not be derived from anything the app stored.

### Capture (always on, capped or not)

`lib/services/limits/modelUsageTally.ts`. The request path only increments an
in-memory tally; a timer writes each replica's running totals for the day to
one blob that only that process writes, so there is no per-request storage
write and no contention:

    <statsPrefix>model-usage/<day>/<replica>.json

`<statsPrefix>` is the limits stats prefix in the admin container
(`system/limits/stats/`, `.beta` in the beta ring). This is app-owned storage
beside the limits day summaries. It is NOT the `ai-portal-analytics` delivery
container, which the ETL writes and the app only reads.

Per model, per hashed person, per day: `[requests, calls, promptTokens,
completionTokens]`. Two measures, recorded at two points:

| Measure                                     | Recorded in                                                                 | Counts                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `requests`                                  | `createLimitsMiddleware` (`tallyChatRequest`), after every check has passed | One per admitted chat message, under the model asked for. A tool-loop continuation is the same message. This is what a cap counts. |
| `calls`, `promptTokens`, `completionTokens` | `recordTokenUsage` (`tallyModelCall`)                                       | One per model call that reported usage, workflows included, under the model that served it.                                        |

Bounds: 500 models a day, 20,000 named people per model per day (the rest
share one overflow subject, so totals stay right and the people count becomes
a lower bound), flush every 60 seconds.

Not captured, by design: the user's own models (`byom-`), requests the limits
check let through because it failed open, refused requests (those are in the
decision tallies), and up to one flush interval if a replica dies.

### Day summary (written once per finished day)

`lib/services/limits/modelUsageInsights.ts`, `buildModelDay`:

    <statsPrefix>summary/model-day/<day>.json

Merges every replica's file for the day. Per model it keeps the hashed
`subjects` (needed to merge one person's days across the window) and a
person-free `aggregate`: people, totals, quantiles and the histogram over
`REQUEST_BUCKET_EDGES`. It also stores a `catalog` snapshot (price, size
class, lifecycle, retirement date as they stood that day) and the assumption
versions, so a later price or size change does not rewrite history. This is
sections 4.1 and 4.5.

### Window aggregate (computed on read, not stored)

`loadModelUsage` / `combineModelDays` merge the last `INSIGHT_DAYS` (7) day
summaries per person and return, per model: distinct people, requests, calls,
tokens, active person-days, each person's busiest day (`peaks`, ascending,
largest 5,000 kept) and a per-day series. `GET /api/limits/insights` returns
it as `models` with `modelDays` (the days the capture covers). This replaces
the stored document of section 4.2: seven small files are cheap to merge and
nothing has to be invalidated.

Statistics (quantiles by nearest rank, histogram, cap replay) are computed
from `peaks` by `lib/utils/shared/usageDistribution.ts`, the same code on the
server and in the page.

### What the page derives (`lib/utils/app/modelFacts.ts`)

| Figure                                                | Source                                         | Kind          |
| ----------------------------------------------------- | ---------------------------------------------- | ------------- |
| People, requests, average, median, p75, p95, heaviest | window aggregate                               | counted       |
| Reached a cap, refused requests                       | limits day summaries (`CellInsight`)           | counted       |
| Cap replay ("if the cap were N")                      | `peaks` at or above N                          | counted       |
| Cost of a typical and a long request                  | list price x assumed request                   | estimate      |
| Most one person can cost in a month                   | cap x request cost x 30.4375                   | estimate      |
| Spend over the window                                 | requests x typical request cost                | estimate      |
| CO2e per request and over the window                  | size class x assumed request                   | estimate      |
| Retirement date, notice and move dates, replacement   | model catalog and discovery (`retiresAt` wins) | configuration |
| Access on the replacement                             | rule by rule comparison of the draft           | configuration |

Until the first day summary exists the page falls back to the cap counters
for capped models, says only capped people are counted, and shows totals as
"Not yet known". Usage for everyone appears from the first finished day after
deployment; there is no backfill.

List price and the cost estimates derived from it are shown to every limits
admin on this page; they do not depend on the `limitsCostInsights` flag,
which still gates the estimator and the per-rule cost hints elsewhere.

Models whose retirement date has passed are left out of the grid until the
admin asks for them ("Retired models"). The runway still lists them.

### Retention of the per-replica files

The admin container has no lifecycle rule (admin data must not expire
silently), so the app trims these files itself: `pruneModelUsage` in
`modelUsageInsights.ts`.

- A replica file is removed once its day is more than
  `MODEL_USAGE_RETAIN_DAYS` (14) old. That is longer than the 7-day window on
  purpose: any day the page can show can still be rebuilt from its tallies.
- Nothing is lost. A day's files go only once its summary is stored; a day
  nobody looked at is summarised first, and a day whose summary cannot be
  written keeps its files for the next run.
- It runs behind the insights read every admin view makes, at most once every
  6 hours per process, oldest days first, 10 days per run. It never delays or
  fails the read.
- Day summaries (`summary/model-day/`) are kept: one small file per day.

### Not built

- Section 4.3, the token aggregate from the ETL. Captured tokens are stored
  per model and returned by the API, but the page still prices the ASSUMED
  request, as decided. Measured cost per model can be built from the captured
  tokens later without new capture. Splitting by surface (chat, workflow) is
  not captured.
- Section 4.4 at person level. "How many people on a retiring model are
  blocked on its replacement" cannot be answered: usage is stored against
  hashed ids, which cannot be matched to the groups, domains and mails the
  rules name. The runway compares the RULES of the two models instead and
  offers to copy them across as a draft.

## 1. Decisions already taken

- The grid (concept A) is the page; the open row (concept B) is its editor.
  The retirement runway (C) and the spend map (D) are secondary views.
- Cost and footprint are ESTIMATES from the typical request, not measured
  spend. Every figure derived this way must be labelled as estimated, and the
  page must say what a typical request is. See section 6.

## 2. What each view needs

| View element                       | Measure                                              | Grain                     | Have it today?                |
| ---------------------------------- | ---------------------------------------------------- | ------------------------- | ----------------------------- |
| Grid: people using it              | distinct people                                      | model, window             | Yes (7 days)                  |
| Grid: distribution bar             | median, p75, p95, max of requests per person per day | model, window             | Derivable (7 days)            |
| Grid: cap line, reached the cap    | people at cap, cap events, refusals                  | model, window             | Yes (7 days)                  |
| Grid: most per person per month    | cap x typical request cost                           | model, audience           | Yes (pure calculation)        |
| Grid: estimated spend              | requests x typical request cost                      | model, window             | Requests: partly (see 3.1)    |
| Grid: footprint per request        | size class x typical request                         | model                     | Yes, when a size class is set |
| Open row: histogram                | people per bucket of requests per day                | model, window             | Derivable (7 days)            |
| Open row: average                  | mean requests per active person-day                  | model, window             | No                            |
| Open row: cap replay               | people over cap X, for any X                         | model, window             | Yes (7 days)                  |
| Open row: per-entry ceiling        | entry cap x typical request cost                     | model, entry              | Yes (pure calculation)        |
| Runway: people on a retiring model | distinct people                                      | model, window             | Yes (7 days)                  |
| Runway: blocked on the replacement | people on model A who cannot use model B             | model pair                | No                            |
| Runway: cost of the move           | requests on A x (cost B - cost A)                    | model pair, window        | Requests: partly              |
| Map: popularity vs cost vs spend   | people, cost per request, estimated spend            | model, window             | As above                      |
| Map: "half of requests are short"  | distribution of completion tokens                    | model, window             | No                            |
| Any trend line                     | all of the above over time                           | model, day, 30 to 90 days | No (7 days only)              |

## 3. What exists today

### 3.1 Limits usage summaries (app-owned)

`lib/services/limits/usageInsights.ts` summarises each finished day once into
`<statsPrefix>summary/day/<day>.json` (`DaySummarySchema`). Per metered cell
(`limitKey` plus `modelId` or `series`) a summary holds:

- `subjects`: hashed person id to that day's count (`u`), the cap at the last
  debit (`c`) and the rule that set it (`r`);
- `events`, `blocked`, `eventSubjects`: how often a cap was hit, how often a
  request was refused, and by whom (hashed).

The admin endpoint merges the last `INSIGHT_DAYS` (7) summaries into a
`CellInsight` (`lib/services/limits/wire.ts`): yesterday's people and pressure
bands, people by rule, cap events, and `peaks`, each person's busiest day in
the window, ascending.

What this already answers:

- people per model, cap events, refusals;
- median, p75, p95 and max of each person's BUSIEST day (read off `peaks`);
- cap replay for any cap X (count of `peaks` at or above X).

What it does not answer:

- anything older than 7 days;
- the average, or percentiles over every person-day rather than the busiest
  day (the day summaries hold the per-day counts, but the merged insight keeps
  only the peak);
- total requests per model for the window (derivable from the day summaries,
  not exposed);
- tokens. The token counters (`chat.tokensPerDay`, `chat.tokensPerMonth`) are
  per person, not per model.

Known limits of this source:

- Only models with a metered `model.requests` cell appear. A model nobody has
  capped and that carries no counter has no usage here.
- In observe mode a counter stops at the cap, so usage reads "reached the
  cap", not demand above it. Demand past a cap is in the decision tallies.
- A summary is marked `complete: false` when the day exceeded
  `MAX_DOCS_PER_DAY`; counts are then lower bounds.

### 3.2 Token usage log rows (Azure Monitor)

`lib/services/observability/tokenUsageRecorder.ts` writes one `TokenUsage` row
per model call: `Model` (the model that actually served), `Region`,
`PromptTokens`, `CompletionTokens`, `ReasoningEffort`, `SizeClass`,
`EstimatedCO2Grams`, `EstimatedEnergyWh`, `AssumptionsVersion`, `Surface`,
plus a list-price cost estimate on the OTel `tokens.cost` metric.

This is the only per-model token source. The app does not query it; the ETL
does.

Known limits: the prod ingestion stream still drops `Surface`
(`lib/types/logging.ts`), and no cached-token share is captured, so list-price
cost from these rows is an upper bound.

### 3.3 Delivered report rollups (ETL-owned files, app-built rollups)

`lib/services/analytics/rollupBuild.ts` computes a `FileRollup` per delivered
file. Two datasets are already per model:

- usage reports: `byModel` with `users`, `events`, `messages`;
- emissions reports: `byModel` with requests, prompt tokens, completion
  tokens, logged Wh and logged CO2e, split by the emissions factors.

These are per FILE (a reporting period), carry no per-person distribution,
and are not joined to the limits policy.

### 3.4 Model catalog and assumptions (config)

- `config/models.json`: `pricing` (input, output, cached per 1M tokens),
  `sizeClass`, `lifecycle`, `retirementDate`, `retirementReplacement`,
  `hosting`, `maxLength`, `knowledgeCutoffDate`, capability flags.
- `config/cost.json`: request profiles (light, heavy), deployment multipliers,
  `assumptionsVersion`.
- `config/emissions.json`: Wh per 1k tokens by size class, grid intensity by
  region, PUE, the `typicalRequest` (1,000 prompt tokens, 500 completion
  tokens), `assumptionsVersion`.
- `lib/utils/shared/modelRetirement.ts`: the 30 day notice and 7 day move
  windows, and the forced retirement map.

## 4. Proposed pre-aggregations

Three documents. The first two extend what the limits side already builds, so
they need no new source. The third is the one that needs the ETL.

Conventions for all three:

- A `version` field; a shape change bumps it and older documents are rebuilt
  or ignored, as `ROLLUP_VERSION` does today.
- People are hashed subject ids (`subjectHash`), never names or mail.
- Written once per finished day in the policy timezone, never rebuilt, with
  `complete` carried through from the day summary.

### 4.1 Model day aggregate (new, from the usage documents)

One row per model per day. Built in the same pass that builds the day summary,
so it costs no extra reads.

```ts
interface ModelDayAggregate {
  version: 1;
  day: string; // '2026-11-20', policy timezone
  modelId: string;
  series: string;
  complete: boolean;
  /** People with at least one request that day. */
  people: number;
  /** Sum of requests that day. */
  requests: number;
  /** Largest count by one person. */
  max: number;
  /**
   * People per bucket of requests that day. Fixed, shared bucket edges
   * (section 5), so days can be added together.
   */
  histogram: number[];
  /** Exact quantiles for this single day, for display without bucket error. */
  quantiles: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
  };
  /** People whose count reached their recorded cap. */
  atCap: number;
  /** Cap hits and refusals (decision tallies). */
  capEvents: number;
  blocked: number;
  /** People and at-cap people by the rule that set their cap. */
  byRule: Record<string, { people: number; atCap: number }>;
  /** People with no recorded cap (unlimited, or older counters). */
  withoutCap: number;
}
```

Serves: grid usage columns, estimated spend (requests x typical cost), the
histogram, the average (`requests / people`), any trend line.

### 4.2 Model window aggregate (new, from the day aggregates and summaries)

One row per model per window (7, 30 and 90 days), rebuilt daily. It holds the
measures that cannot be added up from day rows because they are per PERSON
across days.

```ts
interface ModelWindowAggregate {
  version: 1;
  window: 7 | 30 | 90;
  latestDay: string;
  modelId: string;
  series: string;
  /** Distinct people in the window. */
  people: number;
  requests: number;
  /** Person-days with at least one request. */
  activePersonDays: number;
  /**
   * Each person's busiest day, as a histogram on the shared bucket edges.
   * Replaces the raw `peaks` array for windows too large to ship.
   */
  peakHistogram: number[];
  peakQuantiles: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
  };
  /** Each person's mean over their active days, same edges. */
  meanHistogram: number[];
  meanQuantiles: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
  };
  max: number;
  /** People who reached their cap on at least one day. */
  everAtCap: number;
  /** Days on which at least one person reached the cap. */
  daysWithCapHit: number;
  /** New and returning people against the previous window of equal length. */
  newPeople: number;
  lapsedPeople: number;
}
```

Serves: grid distribution bar, open row statistics, cap replay (cumulative
`peakHistogram`), popularity and its change, "caps nobody reaches" and "caps
people reach" signals.

The exact `peaks` array stays for the 7 day window, where it is small enough
and gives an exact cap replay. The histograms take over for 30 and 90 days.

### 4.3 Model token aggregate (new, needs the ETL)

One row per model, day, region and surface, aggregated from the `TokenUsage`
log rows. This is the only way to move from estimated to measured cost and
footprint, and the only source for token distributions.

```ts
interface ModelTokenAggregate {
  version: 1;
  day: string;
  /** The model that served, as logged. */
  model: string;
  region: 'US' | 'EU' | 'default';
  surface: 'chat' | 'workflow';
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Calls per bucket of completion tokens, and of prompt tokens. */
  completionHistogram: number[];
  promptHistogram: number[];
  /** Sums of the logged estimates, and the assumption set behind them. */
  loggedWh: number;
  loggedCO2Grams: number;
  listPriceUsd: number;
  assumptionsVersion: string;
  /** Distinct people, so small groups can be folded when served. */
  people: number;
}
```

Serves: measured spend and CO2e per model, the real request size (to replace
or validate the typical request), "a lighter model would do" signals, the
split between chat and workflows.

Delivery: a new report type or a new sheet in the existing emissions report,
at DAILY grain. The current per-file `byModel` dataset is the same data at
reporting-period grain; the page needs days so it can line up with the usage
windows above.

Note that `calls` here counts model calls (tool-loop rounds included), while
the limits counters count requests. The two must not be presented as the same
number.

### 4.4 Retirement move impact (new, computed in the app)

For each model with a retirement date or a forced retirement, and its
replacement:

```ts
interface RetirementMoveImpact {
  version: 1;
  builtAt: string;
  fromModelId: string;
  toModelId: string | null; // null: no replacement set
  retiresAt: string | null;
  /** Distinct people on the retiring model in the last 30 days. */
  people: number;
  /** Of those, people the current policy blocks on the replacement. */
  blockedOnReplacement: number;
  /** Of those, people whose cap on the replacement is lower. */
  lowerCapOnReplacement: number;
  /** Estimated weekly cost change at last week's volume, typical request. */
  estimatedWeeklyCostDeltaUsd: number | null;
}
```

This cannot come from the hashed summaries: deciding whether a person may use
the replacement means resolving the policy for the real person. It has to be
built server-side from the usage documents (which carry the real subject id)
and stored as counts only. It must be rebuilt when the policy is saved, not
only daily, because a rule change is exactly what the admin is checking.

### 4.5 Catalog snapshot (new, small)

A daily copy of the price, size class, lifecycle and retirement fields per
model, with the cost and emissions `assumptionsVersion`. Without it an
estimate for a past window is silently recomputed with today's prices. With
it, a trend can show the estimate as it stood, and the page can say when a
price changed.

## 5. Percentiles and histograms

Percentiles cannot be added or averaged across days or models. Two rules
follow.

1. Store a histogram on FIXED bucket edges wherever a measure has to be
   combined, and derive percentiles from the combined histogram. Proposed
   edges for requests per person per day (upper bounds, inclusive):

   `1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 500, 1000, +inf`

   Fine at the low end, where most people sit and where the caps are set. The
   edges are part of the document version; changing them is a version bump.

2. Store exact quantiles beside the histogram for the grain at which they are
   exact (one model, one day; one model, one window). The UI shows the exact
   value when it has one and the bucket midpoint otherwise.

Say which population a percentile describes. The concepts use two, and they
answer different questions:

- per person BUSIEST day in the window: "what cap would stop whom". This is
  what the cap replay and the distribution bar use.
- per person MEAN over active days: "what does a normal day look like". This
  is what the average and the cost of a median person use.

Averages are reported per active person-day (people with zero requests are
not counted), and the UI says so.

## 6. Estimated cost and footprint

Until section 4.3 exists, every cost and CO2e figure on the page is:

```
requests (counted) x cost or CO2e of one typical request (assumed)
```

where the typical request is `config/emissions.json` `typicalRequest`
(1,000 prompt tokens, 500 completion tokens), priced at list price from
`config/models.json`, with the size class and EU or US grid intensity for
footprint.

Rules for the UI:

- label the figures "estimated" wherever they appear, including column
  headings and totals;
- state the typical request once on the page, with the assumption version;
- show the heavy profile from `config/cost.json` as the upper range, so a
  ceiling is never read as exact;
- show "Not set" rather than zero for a model with no price or no size class;
- never add an estimated figure to a measured one.

When measured figures arrive they sit beside the estimate, not in its place:
the estimate is what a cap can promise in advance, the measurement is what
happened.

## 7. Privacy

- No pre-aggregation holds a name, mail or raw subject id. Hashed ids appear
  only where a measure must be merged per person across days (the existing
  day summaries); the new documents hold counts.
- The limits admin sees these views as an administrator. If any of them is
  ever shown to a delegated or view-level audience, groups of fewer than
  `SMALL_GROUP_THRESHOLD` (5) people must be folded as the analytics rollups
  already do (`lib/services/analytics/rollupModel.ts`). A model used by three
  people is a small group.
- `byRule` breakdowns name override ids, which can identify a single person
  for a per-person rule. They stay admin-only.

## 8. Storage, cadence, retention

| Document               | Owner | Where                                       | Built                    | Keep                 |
| ---------------------- | ----- | ------------------------------------------- | ------------------------ | -------------------- |
| Model day aggregate    | app   | limits stats prefix, beside the day summary | once per finished day    | 13 months            |
| Model window aggregate | app   | limits stats prefix                         | daily                    | latest only          |
| Model token aggregate  | ETL   | analytics delivery container                | daily                    | per folder retention |
| Retirement move impact | app   | limits stats prefix                         | daily and on policy save | latest only          |
| Catalog snapshot       | app   | limits stats prefix                         | daily                    | 13 months            |

The day summaries themselves are kept as they are; the retention above is for
the new, person-free aggregates, which are small (one row per model per day).

## 9. Gaps (as found during design; see "Not built" for the current state)

- Size class is missing for some live models, so their footprint cannot be
  estimated. Either set it in `config/models.json` or accept "Not set".
- Some `retirementDate` values in `config/models.json` are in the past for
  models that are still served. The runway must read the date discovery
  reports (`retiresAt`), not the static value.
- Models without a `model.requests` counter had no usage in the limits
  summaries. CLOSED: the per-model tally counts every model.
- The prod log ingestion schema drops `Surface`, so chat and workflow calls
  cannot be separated in the token aggregate until it is reconciled.
- Cached tokens are not captured, so list-price cost from token rows is an
  upper bound.

# Model-parity evals

Offline harness for one question: **can a smaller ("aspirational") model, given a better
dynamic system prompt or a cheap agentic recipe, match a larger ("goal") model — without
costing more?**

Nothing here runs in the app or in CI. It reuses the app's real prompt builder
(`lib/utils/app/systemPrompt.ts`) and model catalog/pricing (`config/models.json`), and
talks to Foundry the same way `ServiceContainer` does.

## Run

```bash
az login                                  # harness authenticates as you (EVAL_AUTH=cli)
npm run evals                             # default pair (evals/config/pairs.json), all strategies, all cases
EVAL_PAIR=claude-haiku npm run evals
EVAL_GOAL=gpt-5.4 EVAL_ASPIRATIONAL=gpt-5-mini EVAL_STRATEGIES=baseline,compact npm run evals
EVAL_TAGS=multi-turn EVAL_CASES=multi-turn-followup npm run evals
npm run evals:fresh                       # ignore the run cache
```

| Env                               | Default                  | Meaning                                                                        |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `EVAL_PAIR`                       | `pairs.json` → `default` | Named goal→aspirational pair                                                   |
| `EVAL_GOAL` / `EVAL_ASPIRATIONAL` | from pair                | Model ids from `config/models.json`; override the pair                         |
| `EVAL_GOAL_STRATEGY`              | `baseline`               | Strategy used to produce the goal reference                                    |
| `EVAL_STRATEGIES`                 | all registered           | Comma list of strategies to try on the aspirational model                      |
| `EVAL_JUDGE`                      | goal model               | Judge model id                                                                 |
| `EVAL_COST_CEILING`               | `0.5`                    | Max allowed `candidate cost / goal cost` per case before a strategy is flagged |
| `EVAL_CASES` / `EVAL_TAGS`        | all                      | Filter cases by id / tag                                                       |
| `EVAL_NO_CACHE`                   | unset                    | Re-run everything, including goal references                                   |
| `EVAL_ENV_FILE`                   | `.env.local`             | Which env file to load (`AZURE_AI_FOUNDRY_ENDPOINT` etc.)                      |

Output: `evals/results/<timestamp>_<goal>_vs_<aspirational>.{json,md}` and `evals/results/latest.md`
(gitignored). Goal and candidate runs are cached under `evals/results/.cache/` keyed by
case content + model + strategy + `STRATEGY_VERSION`, so iterating on one strategy only pays
for that strategy plus judging.

## How a run works

1. Every case is run once through the **goal** model with `EVAL_GOAL_STRATEGY` → the reference.
2. Every case is run through the **aspirational** model once per strategy → candidates.
   Multi-turn cases feed each run's _own_ previous answers forward, so a weak turn 1
   degrades turn 2 the way it would in the app.
3. The **judge** scores each candidate turn against the reference turn (parity 0–10 plus
   accuracy/completeness/formatting/concision) and votes pairwise twice with positions
   swapped. Judge cost is reported separately and never charged to a strategy.
4. **Cost** is computed from `pricing` in `config/models.json` for every call a strategy made
   (plans, self-reviews, …). A strategy whose per-case cost exceeds
   `EVAL_COST_CEILING × goal cost` is flagged **over budget** — this is the guard that
   stops an agentic recipe from "winning" by spending its way past the small model's
   price advantage.

Read the report as: _parity ↑, win rate ↑, cost ratio ≤ ceiling_ = the strategy is a
candidate for promotion into the app's prompt composition for that model family.

## Adding things

- **Case**: drop a JSON file in `evals/cases/` (`id`, `tags`, `turns[{user, expect?}]`,
  optional `rubric` and `promptOptions` — the same options `buildSystemPrompt()` takes).
  Write `expect` as what a _good_ answer does, not the answer itself.
- **Strategy**: add `evals/strategies/<name>.ts` exporting a `Strategy`, register it in
  `evals/strategies/index.ts`, bump `STRATEGY_VERSION`. A strategy gets `ctx.invoke()` and
  may call it any number of times (on any model — e.g. plan with the small model, answer with
  it too; every call is costed). Start from `baseline` (app prompt), `compact` (short rule
  list), `scaffolded` (hidden checklist), `plan-then-answer` (2-call agentic).
- **Pair**: add to `evals/config/pairs.json`.

## Promoting a winning strategy

The harness deliberately does _not_ patch the app. Once a strategy wins for a family,
the place to wire it is `buildSystemPrompt()` / `createSystemPromptMiddleware` (which
already has the model in `ChatContext`) — keyed on `series` / `sizeClass` from the catalog —
then re-run the eval with the new `baseline` to confirm parity held.

## Caveats

- Judging uses the goal model by default; it is biased toward its own style. For a
  cross-family pair set `EVAL_JUDGE` to a third model.
- Pricing in `config/models.json` is list price; cached-input discounts only apply when
  the provider reports cached tokens.
- Non-streaming calls; latency numbers are end-to-end per call, not time-to-first-token.

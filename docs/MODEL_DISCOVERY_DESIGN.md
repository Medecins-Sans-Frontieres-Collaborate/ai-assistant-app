# Design: Dynamic Model Discovery from Azure AI Foundry

**Status:** Implemented behind the default-off `NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED` flag; see `MODEL_DISCOVERY_TODO.md` for rollout state.
**Author:** _TBD_ · **Date:** 2026-06-29

---

## 1. Context — why this change

Today the model list shown to users is hardcoded with **zero knowledge of what Azure actually has
deployed**:

- `createModelConfigs()` in `types/openai.ts` defines all ~13 models statically;
  `components/Providers/AppInitializer.tsx:46` loads `Object.values(OpenAIModels)` into the Zustand
  store via `setModels`.
- The same static list is shown in **every region**. There is no per-region availability check —
  `config/models.ts` only has coarse `disabledModels` per environment.

This is what caused the recent EU incident: models were hand-created in `ts-aiassist-live-eu` (drifting
from Terraform), `claude-*` are still missing there, yet the UI offers them anyway because the list is
blind. A discovery-driven list self-corrects per region.

**The goal:** stop hardcoding _which models exist_, while keeping the rich local metadata that Azure
does not expose. The central design principle:

> **Discovery and metadata are separate concerns that we join.**
> Discovery is the source of truth for _availability_. Local metadata is the source of truth for
> _presentation + routing_. A third layer governs _visibility per environment_.

**We already own ~80% of the infrastructure.** `lib/services/agents/AgentDiscoveryService.ts`
discovers Foundry _agents_ via On-Behalf-Of (OBO) tokens, RBAC filtering, 1h caching, region
resolution, and an env flag (`FOUNDRY_DATAPLANE_DISCOVERY`). A `ModelDiscoveryService` is the same
shape pointed at a different endpoint.

### What we want

1. **Discover** which models are actually deployed (per region) instead of assuming.
2. **Keep local metadata** (context window, taglines, icons, routing `sdk`, **capability/tool flags**)
   because no Azure API returns it — and make that metadata **addable without a code push**.
3. An **env toggle** to choose whether _discovered-but-unknown_ models appear, while always
   restricting the list to _what's actually available_.
4. **Environment/ring visibility gating** so a model can be deployed and tested without regular users
   seeing it in a given ring (dev/beta/prod) — even when prod and beta **share one Foundry instance**.

---

## 2. Background — what Azure discovery can and cannot give us

Research against Microsoft Learn (2025/2026) established the hard constraints that shape this design:

- There is **no single "list everything" API**. Deployment enumeration is a control-plane (ARM) or
  Foundry-project data-plane operation; **an inference API key cannot do it** — it needs an Entra ID
  token plus a read role.
- **No discovery API returns context window, max-token limits, or modalities.** Those live only in
  static docs. Capability _presence_ (can it chat / embed?) is discoverable; capability _sizing_ and
  our routing flags are not.
- Discovery **does** return: deployment name, model name + version, publisher, SKU/capacity, lifecycle
  status, and **retirement dates** (a useful bonus we don't track today).

This is _why_ local metadata must stay — and it validates the layered approach below.

| Approach                       | Endpoint                                                                               | Auth                            | Lists                                                 | Verdict      |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------- | ------------ |
| **Foundry project data-plane** | `@azure/ai-projects` `.deployments.list()` (`api-version=v1`)                          | Entra OBO, `ai.azure.com` scope | Actual deployments                                    | **Primary**  |
| **ARM control-plane**          | `GET …/Microsoft.CognitiveServices/accounts/{acct}/deployments?api-version=2024-10-01` | Entra ARM token, Reader role    | Actual deployments (+ SKU/capacity/state)             | **Fallback** |
| Data-plane `/openai/models`    | `GET {endpoint}/openai/models`                                                         | api-key works                   | Base models the _region offers_ — **not deployments** | ✗ wrong data |

The plan was data-plane primary with ARM fallback; **the Phase 1 spike reversed this — ARM is
primary** (see findings below).

## 2a. Phase 1 spike findings (confirmed against `ts-aiassist-live-eu`)

Running `scripts/discover-foundry-models.mjs` against the live EU resource settled every open
question:

1. **ARM (account scope) is the only working path.** Both data-plane attempts 404 on this
   `kind=AIServices` resource: `@azure/ai-projects@2.0.0-beta.4` `.deployments.list()` →
   `404 Pagination failed`, and `GET {account}/openai/deployments` → `404 Resource not found`. ARM
   `GET …/accounts/{acct}/deployments?api-version=2024-10-01` returns the full list. **So ARM is
   primary, not the fallback.**
2. **Deployments are account-scoped, not project-scoped.** Our `AZURE_AI_FOUNDRY_RESOURCE_ID_*` env
   vars are the _project_ path (correct for agent discovery via `/applications`). Model discovery must
   **strip `/projects/<name>`** to the account path first, else ARM returns
   `AuthorizationFailed … scope is invalid`.
3. **Discovery should run under the APP identity, not per-user OBO.** Listing deployments needs the
   control-plane action `Microsoft.CognitiveServices/accounts/deployments/read` (Reader on the
   account). Unlike agents — which are RBAC-filtered per user — **deployed models are identical for
   every user in a region**, so there is no reason to scope discovery per user. Run it once under the
   app identity (granted account Reader once per Foundry account) and cache globally per region. This
   is _simpler_ than the agent-discovery pattern (no OBO, no per-user cache key). Per-user OBO would
   otherwise force every end user to hold account Reader — a broad, wrong grant.
4. **Join on the deployment `name`, not the model name.** In EU the deployments `gpt-5.2` and
   `gpt-5.2-chat` both run underlying model `gpt-5.5` (`properties.model.name`). The deployment `name`
   is the routing key and matches our `OpenAIModelID`; `properties.model.name` does not and must not be
   the join key.
5. **Filter by capability + state:** keep deployments where `properties.capabilities.chatCompletion
=== "true"` **and** `properties.provisioningState === "Succeeded"`. This correctly drops `whisper`
   and `text-embedding-3-small`.
6. **EU drift, now visible:** EU has 11 deployments. Chat models present: `gpt-5.2`, `gpt-5.2-chat`,
   `gpt-4.1`, `gpt-5-mini`, `o3`, `DeepSeek-R1`, `DeepSeek-V3.1`, `Llama-4-Maverick`, **`Mistral-Large-3`**.
   **Missing** (yet hardcoded, so the UI offers them today and they fail in EU): all `claude-*` and
   `grok-3`. **`Mistral-Large-3`** is deployed but absent from our static list — the exact
   discovered-but-unknown case `SHOW_MODELS_WITHOUT_METADATA` governs.

**Confirmed `DeployedModel` ARM shape:**

```jsonc
{
  "name": "Llama-4-Maverick-17B-128E-Instruct-FP8", // deployment name → join key (OpenAIModelID)
  "type": "Microsoft.CognitiveServices/accounts/deployments",
  "sku": { "name": "GlobalStandard", "capacity": 250 },
  "properties": {
    "model": { "format": "Meta", "name": "...", "version": "1" }, // format → publisher
    "provisioningState": "Succeeded",
    "capabilities": { "chatCompletion": "true", "agentsV2": "true" }, // string-valued flags
  },
}
```

---

## 3. Architecture

```
discover()  → DeployedModel[]              (live, per region, RBAC-filtered, cached)
metadata()  → Map<modelName, OpenAIModel>  (layered: JSON baseline + ARM tag overlay)

visibleModels = for each deployed model d:
    meta = metadata.get(d.modelName)
    if (meta)                              → enrich (meta + live lifecycle/retirement)
    else if (SHOW_MODELS_WITHOUT_METADATA) → enrich with inferred safe defaults
    else                                   → drop
    then apply RING GATE (config/models.ts): drop if disabled for this app's ring
  // static models NOT in discovery → hidden (unless NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED is off)
```

**Three layers, each owning exactly one concern:**

| Layer           | Source of truth for                                    | Lives in                                  |
| --------------- | ------------------------------------------------------ | ----------------------------------------- |
| **Discovery**   | _What is deployed_                                     | Live Azure call (`ModelDiscoveryService`) |
| **Metadata**    | _How to display & route_ (incl. capability/tool flags) | `config/models.json` + ARM `ui-*` tags    |
| **Ring policy** | _Where it's visible_ (dev/beta/prod)                   | `config/models.ts`                        |

The final list = `discovered ∩ metadata`, with `SHOW_MODELS_WITHOUT_METADATA` governing unknowns, then
the ring gate removing anything not allowed in this app's environment.

### 3.1 Discovery layer — `lib/services/models/ModelDiscoveryService.ts` (new)

Singleton with a `Map` cache (1h TTL), keyed by **account resource path (region)** — _not_ per user,
since deployments are region-uniform (spike finding #3).

- **Source (primary):** ARM `GET …/Microsoft.CognitiveServices/accounts/{acct}/deployments?api-version=2024-10-01`,
  paginated via `nextLink`. The data-plane SDK path is dead on this resource kind (finding #1).
- **Identity:** the **app identity** (`DefaultAzureCredential` / `createAppIdentityCredential()`,
  scope `https://management.azure.com/.default`), not per-user OBO. Requires the app principal to hold
  **Reader** (or Cognitive Services Contributor) on each Foundry account.
- **Scope:** strip any `/projects/<name>` suffix off the configured resource id to get the account path
  (finding #2) via a new `stripToAccountPath()` in `lib/utils/shared/armPath.ts`; validate with the
  existing `isValidFoundryResourcePath`.
- **Filter:** keep deployments where `properties.capabilities.chatCompletion === "true"` **and**
  `properties.provisioningState === "Succeeded"` (finding #5) — drops whisper/embeddings.
- **Returns** `DeployedModel { deploymentName, modelName, modelVersion?, publisher?, sku?, capacity?,
capabilities, provisioningState?, tags? }`, where `deploymentName` (ARM `name`) is the join key
  (finding #4).

### 3.2 Metadata layer — layered (JSON baseline + ARM tags)

- **Baseline:** move the current hardcoded values out of `createModelConfigs()` into
  **`config/models.json`** (one entry per known model: `maxLength`, `tokenLimit`, `sdk`, `provider`,
  `tagline`, `modelType`, capability flags). `OpenAIModels` / `OpenAIModelID` are rebuilt from this
  JSON so **all existing call sites keep working unchanged**.
- **Overlay:** read `ui-*` **ARM resource tags** off each discovered deployment — the _same convention
  `AgentDiscoveryService` already parses_ (`ui-icon`, `ui-color`, `ui-category`, `ui-maintained-by`).
  Extend with model-specific keys: `ui-tagline`, `ui-context` (→ `maxLength`), `ui-output`
  (→ `tokenLimit`), `ui-sdk`, `ui-provider`, `ui-agent-id`. Tags override/extend the JSON baseline.
- **Net effect:** an admin adds a model in Azure and sets a few tags → it appears with full metadata,
  **no deploy**. The JSON baseline guarantees today's models render identically even with no tags.

#### Capability / tool knowledge lives here too (Azure discovery does not return it)

The current "tool knowledge" in the TypeScript setup is a set of local flags, all of which stay in the
metadata layer:

- **Parameter capabilities:** `supportsTemperature`, `supportsReasoningEffort`,
  `supportsMinimalReasoning`, `supportsVerbosity` — read by `AzureOpenAIHandler.ts:202-238` to decide
  which request params to send.
- **Vision:** today the `OpenAIVisionModelID` enum, consumed via `ModelSelector.supportsVision()` and
  `ActiveFileInjector.ts:114` to gate image injection. Prefer a `supportsVision` _flag_ in the metadata
  so discovered models can declare it (keep the enum as a thin derived view if other call sites need
  it).
- **Agent backing:** `isAgent` + `agentId` + `agentVersion` (the `AGENT_NAMES` map in `types/openai.ts`).
  **Important nuance:** the built-in GPT/Claude "models" are actually invoked as Foundry _agents_
  (`gpt-52`, `claude-opus-46`) via `AIFoundryAgentHandler` — so their real routing key is `agentId`,
  which is local metadata, **not** something model-deployment discovery returns. The JSON baseline
  keeps these mappings; tags can supply `ui-agent-id` for new agent-backed models.
- **Standard-path tools** (`ToolType = 'web_search'` via `ToolRouterService`) and **agent-side tools**
  (code interpreter, file search, MCP — configured server-side in the Foundry agent and surfaced by
  `foundryEventMappers.ts`) are **unchanged**. They are not part of model-deployment metadata and need
  no discovery work.
- **Unknown models** (shown only when `SHOW_MODELS_WITHOUT_METADATA`) get conservative inferred
  defaults: no vision, no reasoning/verbosity params, no agent backing, plain-chat routing (see §3.4).

### 3.3 Merge + visibility — new `/api/models` route + `AppInitializer`

- Replace the static `Object.values(OpenAIModels)` load in `AppInitializer.tsx:46` with a fetch to a
  new **`app/api/models/route.ts`** — cloned almost verbatim from `app/api/agents/route.ts` (OBO
  acquisition, `OfficeResolver` region resolution, prod-vs-dev credential fallback, graceful
  empty-on-failure).
- The route returns the joined, region-correct list. **Graceful degradation:** if discovery fails
  (OBO down, RBAC denied), fall back to the static JSON list so chat never goes modelless — the same
  pattern the agents route already uses.

### 3.4 Routing fallback for unknown models (correctness detail)

`HandlerFactory` (`lib/services/chat/handlers/HandlerFactory.ts:39-59`) routes on `model.sdk`.
Discovery does **not** return `sdk`, so a discovered-but-unknown model must infer it or chat breaks:

- `publisher === 'OpenAI'` → `azure-openai`
- `publisher === 'Anthropic'` → `anthropic-foundry`
- else → `openai` (standard Foundry-OpenAI-compatible handler); set `avoidSystemPrompt` only when
  known-needed.

Unknown models also get **conservative token defaults** and are **excluded from
`DEFAULT_FALLBACK_CHAIN`** (`config/models.ts`) so a half-known model can't silently become a fallback
target.

### 3.5 Environment / ring visibility gating — `config/models.ts` (static)

Because prod and beta can point at the **same Foundry instance**, discovery returns the _same_ model
set to both — so "deployed but hidden in prod, visible in beta" cannot come from discovery. It is a
**policy layer applied after the discovery + metadata merge**, owned by `config/models.ts` (the
existing environment-config file) and kept in code for auditability.

- **Extend the ring enum:** `Environment` today is `'localhost' | 'dev' | 'prod'`
  (`config/models.ts:7`). Add `'beta'` and map it in `getCurrentEnvironment()` from `NEXT_PUBLIC_ENV`
  (e.g. `'beta'`/`'staging'` → `beta`). Each app build/deploy carries its own `NEXT_PUBLIC_ENV`, so two
  apps on one Foundry still gate differently.
- **Reuse `disabledModels` per ring:** `isModelDisabled(modelId)` (`config/models.ts:83`) already
  filters by the current ring. A model under test is listed in `modelConfigs.prod.disabledModels`
  (hidden in prod) while absent from `beta`/`dev` (visible there). Promote to prod = remove it from the
  prod list (one PR/deploy — the accepted cost of the static approach).
- **Apply to discovered models by id, server-side.** Today `isModelDisabled` runs client-side in
  `AppInitializer.tsx:46`. Move/duplicate this filter into the new `/api/models` route so a prod-hidden
  model **never reaches the client** (don't leak its existence). This also covers
  _discovered-but-unknown_ test models: list the deployment's discovered id in the ring's
  `disabledModels` to hide it in prod even before metadata exists. Retain the client-side filter as
  defense-in-depth.
- **Composes with existing gates:** per-user `hiddenModelIds` (`settingsStore.ts`) and the LaunchDarkly
  flags (`exploreBots`, `enableClaudeModels` in `ModelSelect.tsx:49`) remain untouched and stack on
  top. This design does **not** move visibility into LaunchDarkly, but flags it as the future seam if
  per-user / instant-toggle gating is ever needed.

---

## 4. Env toggles

Added in `config/environment.ts`, beside `FOUNDRY_DATAPLANE_DISCOVERY`:

| Var                                   | Default | Effect                                                                                                                  |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED` | `false` | Off ⇒ today's static JSON list verbatim (ships dark). On ⇒ discovery join.                                              |
| `SHOW_MODELS_WITHOUT_METADATA`        | `false` | The requested toggle. On ⇒ discovered-but-unknown models shown with inferred defaults. Off ⇒ only models with metadata. |

Defaults reproduce current behavior exactly; enable per-environment to roll out (localhost → dev →
EU → prod).

---

## 5. Files to change (representative, not exhaustive)

- **New** `lib/services/models/ModelDiscoveryService.ts` — mirror `AgentDiscoveryService.ts`
  (credential, cache, region, RBAC, data-plane-primary / ARM-fallback).
- **New** `app/api/models/route.ts` — clone `app/api/agents/route.ts` structure.
- **New** `config/models.json` — baseline metadata extracted from `createModelConfigs()`, **including
  capability/tool flags** (`supportsTemperature`, `supportsReasoningEffort`, `supportsVision`,
  `isAgent`/`agentId`/`agentVersion`, …).
- `types/openai.ts` — `createModelConfigs()` reads from `config/models.json`; `OpenAIModels` /
  `OpenAIModelID` derived so existing imports keep working. Migrate vision to a `supportsVision` flag.
- `config/models.ts` — add `'beta'` to `Environment`; map it in `getCurrentEnvironment()`;
  `disabledModels` per ring is the visibility gate (applied to discovered ids).
- `components/Providers/AppInitializer.tsx:~46` — fetch `/api/models`; fall back to static on failure.
- `client/stores/settingsStore.ts` — `setModels` already accepts a dynamic list (`:280`); ensure it
  tolerates models whose `id` isn't in the static enum (audit call sites that index `OpenAIModels[id]`:
  `useModelOrder.ts:84`, `chatStore.ts:701`, `localStorageService.ts:133` for graceful misses).
- `lib/services/chat/handlers/HandlerFactory.ts` — `sdk`-inference fallback for unknown models.
- `config/environment.ts` — two new flags.
- **Reuse unchanged:** `lib/services/auth/foundryCredential.ts`, `OfficeResolver.ts`,
  `UserTokenProvider`, and the `armPath` / `foundryHostAllowlist` validators.

---

## 6. RBAC / ops note

Listing deployments needs an **Entra token + control-plane read role** — `Reader` (or Cognitive
Services Contributor) granting `Microsoft.CognitiveServices/accounts/deployments/read` on the Foundry
account. The inference API key cannot do it, and the data-plane listing 404s on this resource kind
(spike finding #1).

Discovery runs under the **app identity** (`createAppIdentityCredential()` →
`management.azure.com/.default`), **not** per-user OBO: deployed models are region-uniform, so there's
no per-user RBAC to honor, and per-user OBO would otherwise force every end user to hold account
Reader. **The one ops action** is granting the app's managed identity/SP `Reader` on each Foundry
account (EU + US). No per-user grants, no new token plumbing beyond the existing app credential.

---

## 7. Phased rollout

1. **Read-only spike** — a script hitting `@azure/ai-projects .deployments.list()` against
   `ts-aiassist-live-eu` to confirm the `ModelDeployment` field shape and see the real EU deployments
   (validates the premise and surfaces the EU drift directly).
2. **Metadata extraction** — `config/models.json` (incl. capability/tool flags) +
   `createModelConfigs()` refactor; add the `'beta'` ring. No behavior change, all tests green.
3. **Discovery service + route** — behind `NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED=false`; ring gate applied
   server-side in `/api/models`.
4. **Wire `AppInitializer` + visibility/toggle + ring gating**; enable on localhost/dev.
5. **Tag a few EU deployments**, enable in EU, validate, then prod.

---

## 8. Risks & mitigations

| Risk                                                                     | Mitigation                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `@azure/ai-projects` `ModelDeployment` field names unverified            | ARM fallback is the safety net; the Phase 1 spike resolves it before committing.                    |
| Call sites assuming `OpenAIModels[id]` exists could break on dynamic ids | Audit + graceful fallback (codebase already does `?? getFallbackModel(...)` in `chatStore.ts:710`). |
| ARM throttling (~12k reads/hr per principal)                             | Cache (1h TTL) + prefer the data-plane path (avoids the subscription bucket).                       |
| Unknown models without `sdk`/limits                                      | Inference (§3.4) + conservative defaults + exclusion from the fallback chain.                       |
| New UI strings across 33 locales                                         | Per project convention, add only to `messages/en.json`; locale propagation is handled separately.   |

---

## 9. Verification (for the eventual implementation)

- **Spike:** run the read-only discovery script against EU; confirm the returned deployment list
  matches reality (and exposes the missing `claude-*`).
- **Unit:** `ModelDiscoveryService` tests (mock ARM + data-plane responses; cache hit/miss; RBAC-403 →
  empty) under `vitest.config.node.mts`, mirroring existing `AgentDiscoveryService` tests.
- **Metadata refactor:** existing model/store tests stay green (proves no behavior change with flags
  off).
- **Toggle matrix:** test the four combinations of the two env flags (off/off = static; on/off = known
  only; on/on = include unknowns; routing-inference for an unknown model).
- **Ring gating:** assert a model in `modelConfigs.prod.disabledModels` is excluded from `/api/models`
  when ring = prod but present when ring = beta — verifying it is filtered **server-side** (never sent
  to the prod client), for both a known and a discovered-but-unknown id.
- **Capability flags:** assert a discovered known model carries its metadata flags (e.g.
  `supportsReasoningEffort`, `supportsVision`, `agentId`) and that an unknown model gets the
  conservative defaults and routes via the inferred handler.
- **E2E manual:** with the existing running dev server (do **not** start a second instance), flip
  `NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED=true` locally and confirm the picker reflects discovered deployments and
  that chat still routes correctly for a discovered known model.
- **Pre-PR gates:** `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.

---

## Appendix — primary sources

- Deployments – List (ARM): <https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/deployments/list?view=rest-aiservices-accountmanagement-2024-10-01>
- Models – List (data-plane): <https://learn.microsoft.com/en-us/rest/api/azureopenai/models/list?view=rest-azureopenai-2024-10-21>
- Accounts – List Models (ARM): <https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/accounts/list-models?view=rest-aiservices-accountmanagement-2024-10-01>
- Foundry auth/RBAC: <https://learn.microsoft.com/en-us/azure/foundry/concepts/authentication-authorization-foundry>
- Model retirements API: <https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirements>
- `azure-ai-projects` SDK: <https://learn.microsoft.com/en-us/python/api/overview/azure/ai-projects-readme?view=azure-python>

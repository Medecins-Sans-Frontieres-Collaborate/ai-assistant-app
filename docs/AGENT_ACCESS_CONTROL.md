# App-Layer Agent Access Control (Option 2 implementation)

**Status:** Implemented (v1) — flag-gated, off by default.
**Origin:** `docs/AGENT_PERMISSION_GRANULARITY_PROPOSAL.md` Option 2, with modifications agreed 2026-07-17.

---

## Trust model (read this first)

- **Azure project RBAC remains the outer gate.** App-layer rules only ever _further restrict_ what a
  user's own Azure RBAC already allows. They can never grant access Azure denies.
- The application is the trust boundary **only** for sub-project granularity within projects the user
  can already reach via their OBO token.
- **Admins are also bound by RBAC.** Global admins see agents through their _own_ OBO discovery
  (regional + office + custom sources) — there is no app-identity enumeration endpoint, and the
  production fail-closed policy (no app-identity fallback) is unchanged. A global admin can view or
  edit the rule for _any_ existing canonical key (agents they cannot discover show as
  "not discoverable by you" in the UI); authoring a _new_ rule through the UI requires the agent to
  appear in the admin's own discovery, while arbitrary keys remain supported via
  `PUT /api/agent-access/rules` directly. Note the discovery filter applies to admins' own
  `/api/agents` results too: an admin who restricts an agent without including themselves sees it
  flagged "not discoverable by you" yet can still edit its rule.
- **BYO agents are out of scope.** `byom-` custom-source models bypass this system entirely (they
  live outside app curation by design). The `/api/agents/browse` endpoint (BYO source browsing) is
  likewise not filtered in v1. In the other direction, prompt agents never appear in the BYO
  connect flow: `AgentSourceForm` filters `/api/agents` responses to entries whose `source` equals
  the validated resource path, so app-defined personas (source `prompt-agent`) and other discovery
  buckets are excluded from the connection's agent list and count.

## Storage layout

All blobs live in the **primary region's** storage account/container (same account as file uploads:
`AZURE_BLOB_STORAGE_NAME` + `AZURE_BLOB_STORAGE_CONTAINER`, falling back to
`AZURE_BLOB_STORAGE_IMAGE_CONTAINER` per the app-wide convention), under a reserved prefix that cannot
collide with user upload paths (`<userId-guid>/uploads/...`):

```
system/agent-access/config.json                          # delegation map (global-admin writable only)
system/agent-access/rules/<sha256(canonicalKey)>.json    # one rule file per agent
system/agent-access/history/<sha256(canonicalKey)>/<iso-ts>.json  # immutable audit copies
system/agent-access/prompt-agents/<id>.json              # app-defined prompt agents (see below)
```

`prompt-agents/` is deliberately a **sibling** of `rules/`, never nested under it: the rules listing
is fail-closed (any schema-invalid blob under `rules/` fails the whole ruleset load and denies all
Foundry invocations), so an alien blob type must never live there. The prompt-agents listing has the
**opposite** posture: a malformed/hand-placed persona blob is **skipped with a loud
`console.error`** (a dropped persona fails safe — it vanishes from discovery and its botId falls
through to vanilla chat), and the persona listing as a whole loads in an **independently-degradable
step** of the snapshot refresh — a persona-side storage failure keeps the previous personas
(last-known-good) while rules/config still refresh and enforce. A broken persona can therefore never
brick Foundry invocations or freeze rule propagation.

- **Canonical key** = `${source.trim().toLowerCase()}::${agentName.trim().toLowerCase()}`.
  ARM resource paths are case-insensitive to Azure but were compared as raw strings elsewhere in the
  app — rule matching MUST canonicalize both halves (lowercase + trim) to prevent case-variant
  bypass.
- **Writes MUST bypass `AzureBlobStorage.upload()`** (its same-byte-length dedupe silently drops
  writes — see `lib/services/backup/server/backupBlobStore.ts:18-24`) and use
  `getBlockBlobClient().upload(...)` with ETag conditions (`ifMatch` for updates,
  `ifNoneMatch: '*'` for creates). 412 → surface as a 409 conflict to the client. This mirrors the
  backup-manifest CAS pattern exactly.
- Every successful rule write also **attempts** to append an immutable history blob
  (`ifNoneMatch: '*'`) recording the full rule + `updatedBy` + timestamp — the audit/rollback trail.
  The append is **best-effort**: if it fails, the rule mutation still succeeds (200) and the failure
  is only logged (`[agent-access-admin] HISTORY WRITE FAILED`), so gaps are possible during storage
  incidents; a 412 on a history blob is treated as idempotent success (retry after a lost response).
  The structured audit log line always fires regardless. `config.json` (delegation map) changes
  write **no** history blob — they are traceable only via the `[agent-access-admin]` log line (and
  blob versioning, if enabled on the storage account).

### Rule file schema (zod-validated)

```jsonc
{
  "version": 1,
  "source": "/subscriptions/.../projects/x", // original casing preserved for display
  "agentName": "finance-bot",
  "access": {
    "type": "restricted", // "public" | "restricted"
    "allowDomains": ["example.com"], // matched against the part after '@' in session.user.mail
    "allowUsers": ["a@example.com"], // matched lowercased against session.user.mail
    "allowGroups": [], // SCAFFOLD ONLY — persisted, never evaluated (see below)
  },
  "updatedBy": "admin@example.com",
  "updatedAt": "2026-07-17T00:00:00Z",
}
```

### config.json schema

```jsonc
{
  "version": 1,
  "localAdmins": [
    { "email": "lead@example.com", "agentKeys": ["<canonicalKey>", "..."] },
  ],
  "updatedBy": "admin@example.com",
  "updatedAt": "2026-07-17T00:00:00Z",
}
```

## Evaluation semantics

`evaluateAccess(userMail, source, agentName)`:

1. No rule file for the canonical key → **allow** (deny-list semantics; the proposal's
   `defaultWhenUnmatched: allow`). An explicit `"type": "public"` rule is equivalent but documents
   intent.
2. `"type": "restricted"` → allow iff lowercased `userMail` is in `allowUsers` OR its domain is in
   `allowDomains`. Missing/undefined `session.user.mail` → **deny** for restricted agents.
3. `allowGroups` is stored but **never evaluated** in v1; a non-empty `allowGroups` on a matched
   rule logs a warning so admins notice it grants nothing yet.
4. **Unresolved source at invocation** (client omitted/invalid `agentSourcePath` and lazy discovery
   could not resolve it): if _any_ rule exists for that `agentName` under _any_ source, the user
   must satisfy **every** such rule; if none exist → allow. This closes the
   omit-the-source-path bypass.
5. **Rules unavailable** (blob read failure): serve the last-known-good in-memory ruleset. If the
   feature is enabled and there is no LKG (cold start + storage outage), **invocation is denied for
   all Foundry agents** (fail closed) and discovery passes through unfiltered (visibility-only
   surface; names may show but nothing is invocable). Break-glass: set
   `AGENT_ACCESS_CONTROL_ENABLED=false` and redeploy.

## Enforcement points (both, always)

1. **Discovery filter** — `app/api/agents/route.ts`, after the dedupe loop: drop agents the user
   fails `evaluateAccess` for (source is always known here). UX-level only.
2. **Invocation guard** — `lib/services/chat/pipeline/Middleware.ts`
   (`createCredentialMiddleware`): covers **every** agent invocation that can reach the agent
   execution path (`agentMode` + `model.agentId` — i.e. `foundry-`, `org-`, and `custom-` model ids
   alike, since those fields are client-controlled), not just the Foundry-classified subset.
   Foundry-classified agents are evaluated after `agentName`/`sourcePath`/endpoint resolution;
   other agent-mode invocations never resolve a verified source path and are evaluated under the
   unresolved-source semantics (`source: null`). A deny or `unavailable` decision blocks the
   invocation **in every environment** (an access denial is policy, not credential plumbing — it
   does not inherit the dev-mode leniency of the OBO fail-closed path). This is the security
   control: it re-checks on every invocation, so neither the 24h `userAgentEndpoints` trust-anchor
   cache nor the lazy discovery block can keep a revoked user invoking (max revocation latency =
   rules cache TTL).

Every allow/deny decision at the invocation guard emits a structured audit log line
(`agent-access-audit`: user mail, agentName, source, decision, reason).

## Caching & staleness

`AgentAccessService` is a per-process singleton: lists + fetches all rule blobs, TTL **60 seconds**,
keeps last-known-good on refresh failure. Admin writes invalidate the cache on the replica that
served the write; other replicas converge within the TTL. **Max cross-replica revocation latency ≈
60s.** (All existing caches in this app are per-process with no cross-replica invalidation; this
follows the same convention with a deliberately short TTL because it is a security control.)

Freshness by surface: `/api/agent-access/me` and the admin page's server gate answer from the same
≤60s snapshot; `GET /api/agent-access/rules` and `GET/PUT /api/agent-access/config` read storage
directly so the ETags they echo are always current for CAS editing. The client caches `/me` for
5 minutes (React Query `staleTime`), so a delegation change can take up to ~6 minutes to appear in
the Settings sidebar — harmless, since every server surface re-checks authorization itself. During
a cold-start storage outage, config-based local admins transiently lose adminship (the `/me`
response, the admin page, and the rules routes) until a refresh succeeds; `AGENT_ACCESS_ADMINS`
global admins are env-derived and unaffected.

## Admin identity

- **Global admins:** `AGENT_ACCESS_ADMINS` env var — comma-separated emails, matched lowercased +
  trimmed against `session.user.mail` (which is Graph `mail`, not UPN — populate the env var with
  `mail` values). Requires a redeploy to change; this is the bootstrap mechanism.
- **Local admins:** listed in `config.json` (`localAdmins`), editable only by global admins through
  the UI — no redeploy needed. A local admin may create/edit/delete rules **only** for the canonical
  keys delegated to them (a simple per-file authorization check — this is why rules are one file per
  agent).
- **Agent-less local admins:** `isLocalAdmin` is **membership** in `localAdmins` — an entry with an
  empty `agentKeys` list still confers adminship (sidebar link, admin page, `GET` routes answer 200
  with empty lists). A zero-key local admin can **create prompt agents** (the create auto-delegates
  the new key to them — see below) but can edit nothing else until keys are delegated. This is the
  intended onboarding path: add someone as a local admin with no keys, and they can start authoring
  their own prompt agents immediately.
- Known caveat: email-keyed identity inherits Graph `mail` weaknesses (can be undefined; IT-side
  mail changes move adminship). Acceptable for v1; oid-keying is the upgrade path if it bites.

## API surface (`/api/agent-access/*`, all `auth()`-gated + admin-gated, 404 when feature disabled)

| Route                             | Method  | Who                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/agent-access/me`            | GET     | any signed-in                        | `{ isGlobalAdmin, isLocalAdmin, editableAgentKeys }` — drives UI visibility                                                                                                                                                                                                                                                                                                                           |
| `/api/agent-access/rules`         | GET     | admins                               | global: all rules (+ etags); local: only delegated keys                                                                                                                                                                                                                                                                                                                                               |
| `/api/agent-access/rules`         | PUT     | admins (per-key authz)               | body `{source, agentName, access}`, header `If-Match` (update) or `If-None-Match: *` (create); 409 on conflict; writes history                                                                                                                                                                                                                                                                        |
| `/api/agent-access/rules`         | DELETE  | admins (per-key authz)               | query `source`+`agentName`, header `If-Match`; writes tombstone history                                                                                                                                                                                                                                                                                                                               |
| `/api/agent-access/config`        | GET/PUT | global only                          | delegation map, same CAS pattern                                                                                                                                                                                                                                                                                                                                                                      |
| `/api/agent-access/prompt-agents` | GET     | admins                               | global: all agents; local: only delegated keys. `{ promptAgents: [{canonicalKey, agent, etag}], promptAgentsUnavailable, fetchedAt }`. On a direct-read failure, admin status (incl. local admins) is resolved from the service snapshot's LKG config so the degraded `promptAgentsUnavailable: true` 200 is served instead of a false 403; a cold replica with no snapshot still fails closed (403). |
| `/api/agent-access/prompt-agents` | POST    | **any** admin (incl. zero-key local) | body `{name, description?, systemPrompt, modelId}`; server generates the id; non-global creators are auto-delegated (503 + rollback on failure; a _failed_ rollback answers a distinct 503 naming the orphaned agent id — see below); writes history                                                                                                                                                  |
| `/api/agent-access/prompt-agents` | PUT     | admins (per-key authz)               | body = POST fields + `id`, header `If-Match` (strong ETag required); 409 on conflict; writes history                                                                                                                                                                                                                                                                                                  |
| `/api/agent-access/prompt-agents` | DELETE  | admins (per-key authz)               | query `id`, header `If-Match`; writes tombstone history; delegation keys are left dangling (see below)                                                                                                                                                                                                                                                                                                |

## Prompt agents

App-defined personas — display name + description + **system prompt** + **model id** — created and
managed by admins through the same panel, served to users through `/api/agents`, and invoked on the
**standard** chat path (never the Foundry agent path). They ride the same feature gate:
`AGENT_ACCESS_CONTROL_ENABLED=false` means no admin routes (404), no discovery entries, no
invocation resolution.

### Identity & storage

- Id: server-generated at create, `prompt-<12 lowercase hex>`, **immutable** — renames never orphan
  rules or delegations. Canonical key: `prompt-agent::<id>` (`PROMPT_AGENT_SOURCE = 'prompt-agent'`
  is a pseudo-source; it cannot collide with ARM paths, which start with `/`). These keys flow
  through `config.json` delegation and access rules as plain strings.
- Blob: `system/agent-access/prompt-agents/<id>.json`, zod-validated (read-side permissive per the
  schema-evolution rule):

```jsonc
{
  "version": 1,
  "id": "prompt-ab12cd34ef56",
  "name": "Travel Advisor",
  "description": "Helps plan travel",
  "systemPrompt": "You are ...",
  "modelId": "gpt-5.2", // must exist in OpenAIModels; never foundry-/org-/custom-/byom-
  "createdBy": "lead@example.com",
  "createdAt": "2026-07-18T00:00:00Z",
  "updatedBy": "lead@example.com",
  "updatedAt": "2026-07-18T00:00:00Z",
}
```

- Same CAS discipline as rules (writes bypass `AzureBlobStorage.upload()`, `If-Match` /
  `If-None-Match: *`, 412 → 409) and the same best-effort history blobs at
  `history/<sha256(canonicalKey)>/<iso-ts>.json` (upserts + delete tombstones).

### Auto-delegation on create (local admins)

Any admin may create — including zero-key local admins. After a **non-global** admin's create, the
server appends the new canonical key to every `localAdmins` entry matching the creator (CAS
read-modify-write, up to 3 attempts on 412). If delegation persistently fails, the just-created
agent blob is **deleted again** and the create answers 503
(`Could not record delegation; agent creation rolled back`) — a local admin must never own an agent
they cannot edit. Global-admin creates skip delegation.

If the **rollback delete itself fails** (compound storage failure), the route never claims a
rollback happened: it answers a distinct 503 naming the agent id
(`Could not record delegation AND rollback failed: agent <id> still exists without delegation and
needs global-admin cleanup`), logs `ROLLBACK DELETE FAILED` with the id, and appends a best-effort
history `upsert` entry so the orphan is on the durable audit trail. The orphan has **no rule**
(visible to every user under deny-list semantics) and **no delegation** (only a global admin can
edit/delete it from the admin panel) — global admins should clean it up promptly.

**Deletes leave delegation keys dangling** in `config.json` — they render as "Unknown agent key" in
the Local admins UI and can be unchecked there. Accepted for v1.

### Enforcement

1. **Discovery:** `/api/agents` appends prompt agents from the AgentAccessService snapshot (same
   60s TTL/LKG cycle as rules — no direct storage read on this hot path), filtered per-user via
   `evaluateAccess(userMail, 'prompt-agent', id)`. The wire shape is
   `{ id, name, description, agentName: id, source: 'prompt-agent', type: 'prompt' }` —
   **systemPrompt and modelId are never sent to users** (admin surfaces read the admin route). The
   Foundry endpoint trust-anchor caching does not run for them. Prompt agents are served on
   **every** `/api/agents` response path — including when Foundry discovery is skipped entirely (no
   ARM paths configured) or degrades (production OBO token failure): personas need neither ARM
   discovery nor an OBO token. During a snapshot outage the LKG snapshot serves; a cold-start
   outage snapshot simply carries no prompt agents (a persona-listing failure alone degrades only
   the persona half — see the storage section).
2. **Invocation guard:** the client selects a prompt agent through the existing `org-` model-id
   wiring, which sets `conversation.bot` (`botId`) — a client-controlled value, so discovery
   filtering is UX only. `createCredentialMiddleware` re-resolves the botId against the snapshot on
   every request and re-runs `evaluateAccess`; deny/unavailable → `AGENT_UNAVAILABLE` in **every**
   environment, with the same `agent-access-audit` log line as the Foundry guard. The guard runs
   **first**, before the byom early-return and the Foundry model classification, so a prompt botId
   paired with a `byom-`/Foundry-shaped model cannot skip it on any classification path. Fail-closed
   'unavailable': when the botId is `prompt-`-shaped and **no snapshot was ever loaded** (cold start
   during a storage outage), the invocation blocks with `AGENT_UNAVAILABLE` — same contract as the
   Foundry guard. With a snapshot present, a `prompt-` botId that resolves to no record (deleted)
   silently degrades to vanilla chat, like removed static agents. Non-`prompt-` botIds (static RAG
   agents) never touch the access service on this path.

### Invocation semantics (model swap)

`createModelSelectionMiddleware` resolves the botId to the record and **swaps the executing model**
to `OpenAIModels[record.modelId]` — unlike static org agents (whose base model is cosmetic), the
admin-chosen model actually executes. The resolution (and swap) is **scoped to requests whose model
id is `org-<botId>`** — `conversation.bot` is sent on every request and survives model switches that
bypass ModelSelect (workflow model select, `useModelSelection`), so a stale botId never hijacks an
explicitly selected base/`byom-`/Foundry model. `agentMode` is forced false and `model.agentId` is
never set, so the request can never misroute into the Foundry execution path. A `PromptAgentEnricher`
(registered before RAGEnricher, which skips prompt agents) overrides the system prompt with the
record's, then appends the usual conversation-context sections. If the stored `modelId` vanishes
from `OpenAIModels`, the swap is skipped with a loud log and default model behavior applies (the
access guard still runs regardless — it is independent of the swap).

Prompt agents otherwise ride the standard execution path: web search follows the normal
searchMode behavior (`ToolRouterEnricher` exempts them from the static org-agent gate), and
large-file summarization runs **without** the org knowledge-base grounding (`FileProcessor` drops
`botId` from the summarization call when a prompt agent is resolved — a prompt-agent chat must
never trigger a knowledge-base search).

### Caching & picker staleness

Admin mutations invalidate the server snapshot (this replica) and, client-side, the
`['agent-access-prompt-agents']`, `['agent-access-rules']`, `['agent-access-admin-agents']`,
`['foundry-agents']`, `['agent-access-config']` and `['agent-access-me']` queries — so the admin's
own model picker updates without a reload. **Other users** converge on the picker's normal 24h
staleTime/refresh, exactly like Foundry agent discovery today. Cross-replica server convergence is
the usual ≤60s TTL.

### Known limitations (prompt agents)

- Picker visibility inherits the `exploreBots` flag gating (prompt agents render in the same
  section as org/discovered agents).
- 24h picker staleness for non-admin users (above).
- Static `rag`/organization agents remain unguarded by access rules — pre-existing accepted gap;
  prompt agents are guarded from day one.

## Admin UI

- Page: `app/[locale]/(chat)/admin/agent-access` — server component gates (feature flag + admin
  check) and redirects non-admins; the client never being shown a link is NOT the security control.
- Entry point: a Settings-sidebar item visible only when `/api/agent-access/me` says the user is an
  admin.
- Global admins see: all agents from their own `/api/agents` discovery, merged with all existing
  rules (rules whose agent they can't discover appear as "not discoverable by you").
  Local admins see only their delegated keys.
- Editor: access type (Everyone / Restricted), chip inputs for domains and user emails, and a
  **disabled Groups section** labeled as pending tenant consent.
- Saves send the ETag; a 409 prompts a reload-and-retry.
- **Prompt agents:** an "Add agent" button (visible to every admin, including zero-key local
  admins) opens an inline create card (name, description, system prompt, model — the model list
  excludes agent-backed ids, region-unavailable models, and any id missing from the static
  `OpenAIModels` registry, mirroring the server's `validateModelId`; a stored id that has left the
  registry stays selected but is labeled "(unavailable)", and the resulting 400 surfaces as a
  model-specific error). Prompt-agent rows carry a "Prompt agent" badge and, alongside the normal
  access-rule editor, an "Edit agent" inline editor (PUT with `If-Match`) and a Delete action with
  inline confirm (`DELETE` with `If-Match`); 409s — and a 404 on edit, meaning the agent was
  deleted elsewhere — surface the same reload-and-retry banner. Prompt agents appear in the Local
  admins delegation checkboxes like any other row. For local admins the merged list trusts the
  admin prompt-agents GET (already filtered per delegated key against fresh config) rather than
  re-filtering those rows through `/me`'s ≤60s-stale `editableAgentKeys`, so a fresh create by a
  zero-key local admin never vanishes behind a stale snapshot on another replica.

## Group grants — scaffold status & completion checklist

Group-based grants are **schema-complete but disabled**. Blocked on Entra tenant admin consent
(`docs/M365_GRAPH_PERMISSIONS_REQUEST.md` — tenant currently routes all consent to admins;
`Group.Read.All` is in Phase 3 of that request). To complete the cycle later:

1. Obtain either the `groups` optional claim on the app registration's token configuration **or**
   `Group.Read.All`/`GroupMember.Read.All` consent for a server-side `/me/memberOf` call.
2. Implement group resolution in `auth.ts` / a session-cached resolver, **including the >~200-group
   overage path** (Entra emits a Graph link instead of the inline list) and a groups-specific TTL
   (do not inherit the 30-day JWT lifetime — that would make group revocation latency 30 days).
3. Wire `allowGroups` into `evaluateAccess` (fail closed: unresolvable membership ⇒ the groups
   clause grants nothing).
4. Enable the Groups section in the rule editor.
5. Decide guest/B2B behavior (guests may carry no group claims).

## Environment variables

| Var                            | Default | Purpose                                                   |
| ------------------------------ | ------- | --------------------------------------------------------- |
| `AGENT_ACCESS_CONTROL_ENABLED` | `false` | Master gate for enforcement + admin API + UI              |
| `AGENT_ACCESS_ADMINS`          | —       | Comma-separated global-admin emails (Graph `mail` values) |

## Known limitations (v1, accepted)

- Rules key on the mutable data-plane `agentName` — a rename in a shared project orphans the rule
  (dangling rules render in the UI as "not discoverable", which is also the detection mechanism).
  Binding to an immutable agent id is the upgrade path once the data plane exposes one uniformly.
- Rules blob lives in the primary region's storage account; the EU deployment reads cross-region
  (60s cache makes this one list+get per minute per replica).
- `/api/agents/browse` is unfiltered (BYO scope).
- No global allow-list mode (`defaultWhenUnmatched: deny`) — per-agent `restricted` rules cover the
  known requirement; add a config.json setting if a full allow-list posture is ever needed.

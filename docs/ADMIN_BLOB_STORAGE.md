# Centralized Admin Blob Storage

**Date:** 2026-08-04
**Status:** implemented in app + Terraform working trees; migration + apply pending.

## What lives here

All blob-backed admin/system data, via `lib/services/adminBlobStorage.ts` →
`createAdminBlobStorage()`:

- Agent-access config, rules, and audit history (`system/agent-access/…`)
- Prompt agents, M365 agents, org RAG agent overrides
- Admin MCP connectors, admin guides
- Map datasets (meta + data)
- Usage-limits policy, per-user counters, and history (`system/limits/…`)

`createAgentAccessBlobStorage()` and `createLimitsBlobStorage()` are now thin
wrappers over the shared factory (kept for their many import sites).

## Location and why

`ai-portal-admin` container on the **EU** storage account
(`sttsaiassistliveeu` in live), resolved as:

- account: `AZURE_BLOB_STORAGE_ADMIN_NAME` → `AZURE_BLOB_STORAGE_NAME_EU` →
  `AZURE_BLOB_STORAGE_NAME`
- container: `AZURE_BLOB_STORAGE_ADMIN_CONTAINER` → `ai-portal-admin`

Three invariants drove this (2026-08-04 assessment):

1. **Centralized.** One account + container for every user and replica —
   resolved explicitly, never through `getEnvVariable`'s per-user EU remap.
   An admin edit is a single write all regions observe (≤ the access-rules
   cache TTL).
2. **EU-resident.** This data references principals (user ids, emails, group
   ids) and per-user usage from BOTH regions. A single centralized store can
   only satisfy "EU data never leaves the EU" by living in the EU; US
   references stored in the EU carry no residency cost in the other
   direction.
3. **Lifecycle-free.** Both storage accounts carry a
   `delete-ai-portal-images-after-5-days` lifecycle rule (blobs deleted 5
   days after last modification, prefix-scoped to `ai-portal-images/`).
   Admin data previously lived in exactly that container and is written only
   on admin edits — it would have been silently deleted once the features
   launched. The dedicated container is matched by no lifecycle rule.
   **Never add `ai-portal-admin` to a deletion policy, and keep any new
   lifecycle rules prefix-scoped** — an account-wide rule would silently
   reintroduce the hazard.

## How the container comes to exist

Two layers:

- **Terraform (source of truth):** `azapi_resource.eu_admin_container` in the
  data root module (management plane — the live EU account's firewall is
  `Deny` and CI runners are outside the VNet), all envs. Container-app env
  vars `AZURE_BLOB_STORAGE_ADMIN_NAME` / `_ADMIN_CONTAINER` are wired from
  the data outputs.
- **Runtime backstop:** `createAdminBlobStorage()` runs a once-per-process
  `containerClient.createIfNotExists()` (data-plane; covered by the existing
  Storage Blob Data Contributor grants on both accounts, works over the EU
  private endpoint). A fresh environment self-heals before the next apply.

Health: the deep health check (`azureBlobStorageAdmin`) probes the resolved
admin location with the same credential the stores use, so a missing
container / broken private endpoint / revoked RBAC surfaces as a failing
check instead of globally-stale admin config.

## Migration (one-time, per env, before/at rollout)

Any admin data written before this change sits in `ai-portal-images` under
`system/agent-access/` and `system/limits/` (and is subject to the 5-day
delete, so in practice only recently-touched blobs exist). Copy it to the new
location:

```bash
# Live (adjust account names per env). azcopy with AAD auth; EU data plane is
# reachable from inside the VNet or via a temporary IP allow rule.
azcopy copy \
  "https://sttsaiassistliveplatform.blob.core.windows.net/ai-portal-images/system/*" \
  "https://sttsaiassistliveeu.blob.core.windows.net/ai-portal-admin/system/" \
  --recursive

# Or per-prefix with az CLI (management-plane auth’d copy loop) if azcopy
# can’t reach the EU data plane from your machine.
```

Verify with a listing of `system/` in `ai-portal-admin`, then the old blobs
under `ai-portal-images/system/` can be left to expire (5-day lifecycle) or
deleted.

## Residency/latency notes

- Admin reads on hot paths are served from the access-rules 60 s TTL cache
  with stale-on-error, so the cross-region hop (eastus2 app → westeurope
  account) is paid ~once a minute per replica plus on admin writes.
- Usage-limit counter CAS writes pay the hop per tracked request — verify
  the debit stays off the response path if that ever becomes measurable.
- An EU-storage outage now affects admin-config freshness for all users
  (softened by stale-serve). The health check above makes that visible.

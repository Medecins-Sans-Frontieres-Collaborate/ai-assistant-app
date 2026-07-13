# LaunchDarkly feature flags

Every flag the app reads, what it gates, its fail-behavior when LaunchDarkly
is unreachable or the flag is unserved, and what to serve per environment.

## How flags are wired

- **Client-side only.** All flags are read in React components via `useFlags()`
  from `launchdarkly-react-client-sdk`. There are no server-side flag reads.
- **Provider**: `components/Providers/AppProviders.tsx` mounts `LDProvider`
  with `bootstrap: 'localStorage'`. When `NEXT_PUBLIC_LAUNCHDARKLY_CLIENT_ID`
  is not configured (e.g. local dev), the provider is skipped entirely and
  every flag evaluates to `undefined` — which is why the fail-open/fail-closed
  conventions below matter.
- **Key casing**: the React SDK camel-cases flag keys by default
  (`useCamelCaseFlagKeys`), so a dashboard key `explore-bots` arrives in code
  as `exploreBots`. The names below are the CODE names; check the LD project
  for whether the dashboard key is the kebab-case or camelCase form before
  creating a new one.
- **Targeting context** (`kind: 'user'`): `key` (user id), `email`,
  `givenName`, `surName`, `displayName`, `jobTitle`, `department`,
  `companyName`. Admin-ish gating is done with LD targeting rules on these
  attributes (e.g. department/companyName), not app-side role checks.
- **Env vars**: `NEXT_PUBLIC_LAUNCHDARKLY_CLIENT_ID` (client SDK id, reaches
  the browser) and `LAUNCHDARKLY_SDK_KEY` (server SDK key — currently unused
  by app code). Both optional in `config/environment.ts`.

## Conventions

- **Fail-open** (`flag !== false`): the feature is ON when the flag is
  `undefined` (LD unconfigured/unserved). Used for established features so an
  LD outage doesn't turn the product off. To disable, serve `false` explicitly.
- **Fail-closed** (`flag === true`): the feature is OFF unless the flag is
  explicitly `true`. Reserved for risky surfaces where an outage must degrade
  to "off". Currently only `mcpArbitraryServers`.

## Flag reference

| Code name                  | Gates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Convention                   | Read in                                                                                                                               | Recommended serving                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exploreBots`              | Org-managed agent discovery in the model picker's Agents tab: regional/office Foundry projects + static agents from `organization-agents.json`. User-connected (BYO) sources are deliberately NOT gated by this.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Fail-open                    | `components/Chat/ModelSelect.tsx`, `components/Chat/ModelSelect/AgentsTab.tsx`                                                        | `true` everywhere (established feature). Serve `false` only to hide org agents in an environment.                                                                                                                                        |
| `enableClaudeModels`       | Visibility of `claude-*` models in the model picker (provider `anthropic` filtered out when off). Does not affect existing conversations server-side.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fail-open                    | `components/Chat/ModelSelect.tsx`                                                                                                     | `true` where the Anthropic Foundry deployments exist; `false` where they don't (e.g. environments still missing claude-\* deployments).                                                                                                  |
| `agentSourceBrowse`        | The "browse Azure resources" discovery mode in the BYO Foundry connection form (`AgentSourceForm`). When off, users must enter resource paths manually.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Fail-open                    | `components/Chat/AgentSources/AgentSourceForm.tsx`                                                                                    | Serve `false` in prod until comms go-ahead; `true` in beta.                                                                                                                                                                              |
| `showUsageImpact`          | The "Usage & Impact" settings section (local token/CO2e stats) in the settings sidebar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Fail-open                    | `components/Settings/SettingsSidebar.tsx`                                                                                             | `true` once the section is announced; `false` to hide.                                                                                                                                                                                   |
| `mcpConnectors`            | The entire "Connectors" settings section (curated MCP catalog + arbitrary servers area): sidebar item, mobile nav entries. UI-gating only — servers a user already connected keep being sent with chat requests if the flag is later turned off (flag-off means "stop acquisition", not "break existing users").                                                                                                                                                                                                                                                                                                                                                                                  | Fail-open                    | `components/Settings/SettingsSidebar.tsx`, `components/Settings/MobileNavigation.tsx`, `components/Settings/MobileSettingsHeader.tsx` | Serve `false` in prod until the MCP rollout go-ahead; `true` in beta/dev.                                                                                                                                                                |
| `mcpArbitraryServers`      | Arbitrary (non-catalog) MCP servers: BOTH the settings UI area (user opt-in toggle + add/edit form) AND the chat send path — `AppInitializer` mirrors the flag into `settingsStore.mcpArbitraryFlagEnabled`, and `chatStore` refuses to send arbitrary servers unless the mirror is `true`. Flipping to `false` stops arbitrary servers being sent immediately, without a reload.                                                                                                                                                                                                                                                                                                                 | **Fail-closed** (`=== true`) | `components/Settings/Sections/ConnectorsSection.tsx`, `components/Providers/AppInitializer.tsx`                                       | Serve `true` only where arbitrary MCP servers are explicitly sanctioned. Note the server has an additional independent gate: env `MCP_CUSTOM_SERVERS_ENABLED` (default `false`) must also be set for `/api/mcp/*` to accept custom URLs. |
| `structuredDataExtraction` | The structured-data-extraction UI: the "Extract" toggle in the chat-input Dropdown, the ExtractionTray (recipe-chip row above the composer), and the "Recipes" tab in the Quick Actions (Customizations) modal. UI-gating only — with every entry point hidden the client produces no `extraction` payload, so the server enricher (`ExtractionEnricher.shouldRun()` returns `!!context.extraction`) stays dormant; no server flag read is needed.                                                                                                                                                                                                                                                | Fail-open                    | `components/Chat/ChatInput/Dropdown.tsx`, `components/Chat/ChatInput.tsx`, `components/QuickActions/CustomizationsModal.tsx`          | Serve `false` in prod until the extraction rollout go-ahead; `true` in beta/dev.                                                                                                                                                         |
| `conversationWorkflows`    | Workflow-conversation creation entry points: the workflow row on the new-chat empty state (`WorkflowChooser`) and the workflow items in the sidebar new-chat dropdown. Gates creation ONLY — existing workflow conversations always render their workflow window (the page-level branch reads `conversationType` off the conversation, never this flag), mirroring the `mcpConnectors` "stop acquisition, don't break existing users" rule. No server-side gating: `/api/workflows/*` routes are reachable regardless of the flag (client-side LD only; accepted v1 gap). With LD unconfigured locally the flag is `undefined`, so entry points are hidden — serve or bootstrap the flag to test. | **Fail-closed** (`=== true`) | `components/Chat/EmptyState/WorkflowChooser.tsx`, `components/Sidebar/Sidebar.tsx`                                                    | Serve `false` in prod until rollout; `true` in beta/dev.                                                                                                                                                                                 |
| `enableBYOModels`          | Allows users to connect to their own Azure Foundry instances to use models they'd prefer or their own setup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Fail-closed** (`=== true`) | `components/Chat/EmptyState/WorkflowChooser.tsx`, `components/Sidebar/Sidebar.tsx`                                                    | Serve `false` in prod until rollout; `true` in beta/dev.                                                                                                                                                                                 |

## Related non-LD gates (for completeness)

These are environment variables, not LD flags, but they interact with the
flags above:

- `MCP_CUSTOM_SERVERS_ENABLED` — server-side defense-in-depth for arbitrary
  MCP server URLs (`/api/mcp/tools`, `/api/mcp/oauth/*`, chat tool loop).
  Both this AND `mcpArbitraryServers` must be on for arbitrary servers to work.
- `NEXTAUTH_URL` — required for MCP OAuth connectors (it is the configured
  origin used to build OAuth redirect URIs; never derived from request Host).
  It must be the origin users actually browse.
- `MCP_OAUTH_GITHUB_CLIENT_ID/_SECRET`, `MCP_OAUTH_ASANA_CLIENT_ID/_SECRET` —
  deployment-wide pre-registered OAuth apps for the curated connectors.
  Needed for OAuth on deployed origins: GitHub has no dynamic client
  registration, and Asana's DCR only accepts loopback redirect URIs
  (localhost dev works without these). Register each app with redirect URI
  `${NEXTAUTH_URL}/mcp-oauth-callback`. These are OPTIONAL even in prod:
  users can alternatively supply their OWN OAuth app per connector ("Use
  your own OAuth app" in Connectors — needed anyway for users on different
  provider instances/orgs), whose credentials live in their localStorage
  like PATs.
- `NEXT_PUBLIC_MODEL_DISCOVERY_ENABLED` — live Foundry model discovery
  (see `docs/MODEL_DISCOVERY_DESIGN.md`).

## Adding a new flag

1. Read it with `const { myFlag } = useFlags()` and pick the convention
   deliberately: `!== false` (fail-open) for product features, `=== true`
   (fail-closed) for risky/exfiltration-adjacent surfaces — add a one-line
   comment justifying fail-closed at the call site.
2. If a vanilla (non-React) store needs the value, mirror it into a
   runtime-only store field from `AppInitializer` (see
   `mcpArbitraryFlagEnabled` — NOT persisted, re-derived each session).
3. Document it in this file, and add the flag to the LD project for every
   environment before merging (an unserved flag evaluates as `undefined`).

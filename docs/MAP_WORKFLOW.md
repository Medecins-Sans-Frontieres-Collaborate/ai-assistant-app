# Map workflow: geographic data model & rendering

How the map workflow (`conversationType: 'map'`) turns raw material into
features, and how those features are drawn so the map reads truthfully.
Feature extraction happens in `app/api/workflows/map/route.ts` via a single
strict structured-output call (`lib/services/workflows/map/prompts.ts`);
rendering lives in `components/Workflows/Map/`.

## Input modes

Three ways material reaches the extractor, all landing in the same
`sourceText → features` call:

1. **Paste** — raw text in the input panel.
2. **File** — upload → `/api/file/upload` + `/api/file/process` extracted
   text (same pipeline as chat).
3. **Web search** (globe toggle) — the query runs through the app's
   standard Foundry web search (`AgentChatService.executeWebSearchTool`,
   Bing grounding configured on the Azure agent) and the grounded answer
   text + a source list is fed to the extractor. Citations are recorded on
   the source record (`MapSourceRecord.kind: 'search'`, `query`) and
   appended as links to the rail message so sources stay auditable.
   Requires the default search agent (`OpenAIModels[GPT_5_2].agentId`) to
   be populated by model discovery; otherwise the route returns
   `SEARCH_UNAVAILABLE` and the UI explains web search is unavailable.

## Data model (`MapFeature` in `types/workflow.ts`)

Every feature carries, besides name/coords/category:

| Field                     | Values                                              | Purpose                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confidence`              | `high` / `medium` / `low`                           | How sure the model is about the coordinates. Coordinates come from **model knowledge only** — no geocoding API is ever called (privacy). `(0,0)` and out-of-range coords are dropped server-side.                                                                                |
| `prominence`              | `primary` / `secondary` / `mention`                 | How central the place is to the material. A report about Venezuela that mentions Syria in one sentence yields Venezuela `primary`, Syria `mention` — a passing aside must not read like a second theater of operations.                                                          |
| `granularity`             | `site` / `city` / `district` / `region` / `country` | What kind of place it is. A pin for a field hospital and a centroid for a whole country mean different things; this field keeps them from looking identical.                                                                                                                     |
| `countryCode`             | ISO 3166-1 alpha-2                                  | Containing country; uppercased server-side. Enables containment demotion and downstream GIS joins.                                                                                                                                                                               |
| `parentName`              | string                                              | The broader mapped place this belongs to, as named in the material. Enables containment demotion.                                                                                                                                                                                |
| `approxRadiusKm`          | number                                              | Model-estimated extent for area granularities; clamped per class at render time (`lib/utils/shared/geo/granularity.ts`).                                                                                                                                                         |
| `eventStart` / `eventEnd` | `"YYYY"` / `"YYYY-MM"` / `"YYYY-MM-DD"`             | Event dates from the material, **precision encoded in the string shape** (never interpreted except via `lib/utils/shared/date/partialDate.ts`). Server normalization (`normalizeEventFields`): garbage → empty, transposed ranges swapped, explicit end clears the ongoing flag. |
| `eventOngoing`            | boolean                                             | Started and still continuing ("since March", "remains closed").                                                                                                                                                                                                                  |

All fields are optional on persisted features: conversations saved before a
field existed fall back to the old behavior (`prominence` → `primary`,
`granularity` → `city`).

## Visual channels (one meaning per channel)

| Channel               | Encodes       | Detail                                                                                                                                                                                                                                           |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Color + dash          | `confidence`  | Blue solid = high, amber dashed = medium, red dashed = low.                                                                                                                                                                                      |
| Marker size + opacity | `prominence`  | Mentions are small and faint, and are **excluded from the initial bounds fit** so one faraway aside doesn't zoom the world out.                                                                                                                  |
| Geometry              | `granularity` | `site`/`city` → fixed-pixel point markers. `district`/`region`/`country` → translucent **extent circles** in real meters (`L.Circle`, radius = clamped `approxRadiusKm`), deliberately fuzzy: they say "roughly this area", not "this boundary". |

Additional rules in `granularity.ts` / `MapView.tsx`:

- **Zoom fade**: area circles fade at `fadeZoom` and disappear at `hideZoom`
  (country 6→8, region 8→10, district 10→12). Zoomed into a city, a
  country-sized circle is meaningless backdrop.
- **Containment demotion** (`findDemotedAreaIds`): when finer features link
  to an area — by `parentName`, or by `countryCode` for countries — the
  area is a _container_, not a finding, and renders as outline-only (the
  list badge tooltip explains this). Example: material mapping both "Goma"
  and "DRC" shows Goma as a dot and DRC as a faint outline.
- A toggleable legend (toolbar → Legend) explains all three channels; the
  channel budget is intentionally full — do **not** add a fourth encoded
  dimension to the markers.

## Connections

The extractor also reports relationships the material states between
places — movement of people/teams, cause/effect, supply and deployment
lines, coordination, and historical references. They arrive name-referenced
(`fromName`/`toName`), are resolved to feature ids client-side
(`lib/utils/shared/geo/connections.ts`; same-run features take priority,
unresolved pairs are dropped with a notice), and persist as
`MapWorkflowState.connections` (`kind` is free text, like `category`).
Rendering: dashed gray polylines (`ConnectionsLayer`) that only draw while
both endpoints are visible and dim with faint endpoints; reference-ish
kinds (matching /referen|histor|compar/) render dotted and lighter so a
"like Syria 2023" comparison doesn't read as an active link. Removing a
feature removes its connections. Exports: GeoJSON `LineString` features
and KML `<LineString>` placemarks (CSV stays points-only).

## Map-aware chat rail

The workflow window's conversation rail is overridden for map
conversations (registry `railSend` → `client/services/workflows/map/
mapRailChat.ts`) to a dedicated route, `/api/workflows/map/chat`:

- The client sends the last 12 rail messages plus a compact feature list;
  the server builds a **tiered digest** (header aggregates always; full
  pipe-delimited lines for the ~400 most important features; index lines
  for the rest; explicit omission note) bounded to ~24k tokens.
- The model answers grounded questions (what the material says) from the
  digest only, computes approximate straight-line distances from the
  listed coordinates (labeled as such), and may use general world
  knowledge for terrain/geography questions only when labeled as general
  knowledge.
- **Mutations from chat**: when the user asks to change the map, the
  streamed answer ends with a `[[MAP_EDIT]]` sentinel (held back from
  display via a tail buffer); the route then runs one strict structured
  call producing `addFeatures`/`addConnections`, emitted as a
  `chat_mutations` WORKFLOW_EVENT. The client validates, applies via
  `updateWorkflowState` (cap-checked, name-resolved), and reports the
  outcome inside the assistant message. Pure Q&A turns cost one call.
- Streaming rides the chatStore lifecycle (`initializeStreamingState` →
  `appendStreamingContent` → `finalizeMessage`), so the rail renders it
  like any chat reply and the Stop button aborts it.

## Model switching

Workflow windows have a compact model picker in the shell header
(`WorkflowModelSelect`). It offers only models the workflow routes can run
(`isWorkflowEligibleModel` in `lib/services/workflows/shared/
workflowModels.ts`: Azure-OpenAI base models — no agents, no other
providers) and the server re-validates every request via
`resolveWorkflowModelId` (unknown/ineligible ids fall back to the
default). Switching also changes the rail chat's model.

## Large feature counts

Sized for the 2,000-feature cap on low-end hardware, no new deps:
`preferCanvas` on the MapContainer (one shared canvas instead of ~2000 SVG
nodes), a memoized point/area layer split in `MapView` (zoomend only
reconciles area circles, not every marker), and a virtualized
`FeatureList` (`@tanstack/react-virtual`). Deferred: viewport culling
(canvas already clips; adds pan pop-in and moveend feedback-loop risk) and
marker clustering (DivIcon clusters conflict with the color/size
encodings; unnecessary at this cap).

## Filters and time lapse

Both are **ephemeral view state** in `MapWorkspace` — never persisted with
the conversation — and both apply to the list AND the map together.

- **Category chips** (`lib/utils/shared/geo/categories.ts`): free-form
  model categories are grouped by normalized key (trim/NFKC/lowercase),
  labeled by the most frequent original spelling, capped at 8 chips with
  the tail (and uncategorized features) in one "Other" bucket. Empty
  active set = no filtering.
- **Date-range filter** (`DateRangeFilter`, predicate
  `featureDateRangeVerdict` in `timelineScale.ts`): a full-width row
  above the timeline with one-click **era chips** (the same adaptive
  segments the timeline uses, computed over the category-filtered set so
  the options don't vanish once one is picked), custom from/to date
  bounds (either side may be open), and a prominent Clear. A dated
  feature passes when its coverage interval INTERSECTS the range — the
  identical interval the timeline uses, so filter and time-lapse always
  agree; precision widening means a "2026" event matches any 2026
  sub-range. Undated features can't fail a date test: they follow the
  shared "Show undated" toggle (surfaced in the filter row while a range
  is active) instead of being silently dropped. Filters compose:
  categories → date range → time lapse, so the time-lapse scrubs WITHIN
  the chosen range and its era strip adapts to it.
- **Time lapse** (`lib/utils/shared/geo/timelineScale.ts` +
  `eventTime.ts`, `TimelineControl`, `useTimelinePlayback`): a slider +
  play/pause across the _category- and date-filtered_ set (filters
  compose: categories first, dates second, time third). **Visibility semantics are hybrid**: a
  feature is active at time T when `start ≤ T` and it hasn't explicitly
  ended before T — point events persist after appearing, ranged events
  disappear when the material says they ended, ongoing events persist,
  and precision widening means a `"2026"` date covers the whole year.
  Undated features stay visible but faint (0.3× opacity, dimmed rows)
  with a "Show undated" toggle — hiding them would silently misrepresent
  the dataset. The control appears only when ≥2 dated features exist;
  the max extends to now when anything is ongoing; `prefers-reduced-motion`
  slows playback to discrete ticks.

  **The scale is adaptive, not linear.** Real materials mix a dense
  burst of current events with sparse historical parallels ("similar
  earthquakes in 1812 and 1875…"); a linear axis would hand the slider
  to empty centuries. `computeTimelineScale` clusters dated features
  into **era segments** on their coverage intervals (precision widening
  makes consecutive year-precision dates adjacent, so a decade of yearly
  reports stays one era); a gap splits eras only when it exceeds both
  180 days AND 20% of the total span (largest-gap cap: 8 segments —
  mathematically ≤6 are reachable). The slider and playback run on
  uniform STEP INDICES: each dense segment sweeps on its own
  day/week/month ladder (total capped at ~240 steps by uniform
  coarsening); **sparse segments (≤3 distinct event boundaries)
  collapse to appear/end steps** — a lone "1812" mention never gets a
  year of weekly ticks — and the gap between eras costs exactly one
  tick. With multiple eras the control shows a clickable era strip
  ("1812 ·· 1875 ·· Mar–Jun 2026", widths proportional to step share);
  a stale time landing in a gap after a filter change snaps to the
  nearer era edge. `timeMs` (raw ms) stays the source of truth so
  changing filters never teleports the viewed date.

## Exports

`granularity`, `countryCode`, `parentName`, `approxRadiusKm`, `prominence`,
`confidence`, and the event fields (`eventStart`/`eventEnd`/`eventOngoing`;
CSV: `event_start`/`event_end`/`event_ongoing`) are all carried into
GeoJSON properties, the KML description, and CSV columns, so ArcGIS/QGIS
users can re-symbolize or time-enable layers by any of them. Exports are
always the full (unfiltered) feature set. Geometry in exports is still
points — see below.

## Future work: true boundary polygons (planned)

Extent circles are an honest approximation but still an approximation (a
circle over Chile is not a good shape). The planned follow-up:

- Bundle **Natural Earth admin-0** country boundaries (110m resolution,
  ~few hundred KB GeoJSON) as a static asset — no network calls, works
  offline, consistent with the privacy posture (no boundary API).
- Match features with `granularity: 'country'` to their polygon via
  `countryCode` (reliable, unlike name matching) and render the actual
  outline/fill instead of a circle; keep circles for sub-national areas
  (admin-1 data is ~2 MB+ and name matching is messy — not worth it yet).
- Optionally include the polygon in GeoJSON/KML exports for country
  features.

Also deferred: lines/polygons from the model, clustering, manual pin
editing, offline tile packs (`NEXT_PUBLIC_MAP_TILE_URL` is the seam for
self-hosted tiles).

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

| Field            | Values                                              | Purpose                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confidence`     | `high` / `medium` / `low`                           | How sure the model is about the coordinates. Coordinates come from **model knowledge only** — no geocoding API is ever called (privacy). `(0,0)` and out-of-range coords are dropped server-side.                       |
| `prominence`     | `primary` / `secondary` / `mention`                 | How central the place is to the material. A report about Venezuela that mentions Syria in one sentence yields Venezuela `primary`, Syria `mention` — a passing aside must not read like a second theater of operations. |
| `granularity`    | `site` / `city` / `district` / `region` / `country` | What kind of place it is. A pin for a field hospital and a centroid for a whole country mean different things; this field keeps them from looking identical.                                                            |
| `countryCode`    | ISO 3166-1 alpha-2                                  | Containing country; uppercased server-side. Enables containment demotion and downstream GIS joins.                                                                                                                      |
| `parentName`     | string                                              | The broader mapped place this belongs to, as named in the material. Enables containment demotion.                                                                                                                       |
| `approxRadiusKm` | number                                              | Model-estimated extent for area granularities; clamped per class at render time (`lib/utils/shared/geo/granularity.ts`).                                                                                                |
| `event`          | `{ start, end, precision, ongoing? }`               | When it happened — see "Event timing" below. Never interpreted except via `lib/utils/shared/geo/eventTime.ts`.                                                                                                          |
| `sourceId`       | uuid                                                | Which extraction run produced this feature, resolving to a `MapSourceRecord` (see "Provenance").                                                                                                                        |

All fields are optional on persisted features: conversations saved before a
field existed fall back to the old behavior (`prominence` → `primary`,
`granularity` → `city`).

### Event timing

Timing is **always a range, always expressible to the minute, with the
material's own precision recorded alongside** (`EventRange` in
`types/workflow.ts`, interpreted by `lib/utils/shared/date/eventRange.ts`):

- `start` — inclusive UTC instant, `'YYYY-MM-DDTHH:mm'`.
- `end` — the first instant NOT covered (exclusive), or `null` when the
  material stated no end. **`null` is not "ended now"**: an event with no
  stated end persists on the map after it appears, because the material
  reported that it happened, not that it stopped. Only an explicit `end`
  removes a feature.
- `precision` — `minute` | `hour` | `day` | `month` | `year`. A **display**
  concern, plus the implied width of an open-ended event; it never enters
  interval maths, since the range already says what it covers. This is what
  lets "1812" render as `1812` rather than `1 Jan 1812, 00:00`.
- `ongoing` — explicitly still running ("since March"). Extends coverage to
  now on the timeline. An explicit `end` outranks it.

Splitting the range from its precision is the point: the predecessor shape
encoded precision in a partial ISO string (`"2026-03"`), which could not
express a time of day at all — two events six hours apart collapsed into one
moment on the timeline.

**Legacy features are read, not migrated.** Every map built before this
model still carries `eventStart`/`eventEnd`/`eventOngoing`, and
`featureEventRange()` in `eventTime.ts` is the one read boundary that
presents both shapes as a range. `__tests__/lib/utils/shared/geo/
eventTimeEquivalence.test.ts` pins the contract: for every legacy shape, a
feature and its converted twin agree on visibility at eight probe instants,
on coverage, on display, and on keyframes. Two deliberate corrections came
with the conversion, both documented there: an end-only feature now reads as
the window the material named (it used to be visible from the dawn of time,
an artifact of the old check order), and a stated end outranks the ongoing
flag everywhere (matching what server normalization always claimed).

Coverage intervals are **half-open** throughout. Anything user-facing that
derives from an end has to step back one ms — `segmentLastInstant()`, the
date filter's inclusive `toMs`, era labels, the timeline's end caption —
or a segment covering 1812 reads as "1812–1813".

### Provenance

Every extraction run appends a `MapSourceRecord` (`{id, name, addedAt,
featureCount, kind, query?, url?}`) and stamps its id onto the features it
produced, where `kind` is `text` (name: "Pasted text") | `file` (the
filename) | `search` (the query) | `url` (the page title) | `chat`.
`lib/utils/shared/geo/featureSources.ts` resolves a feature back to its
record, and `sourceHref()` returns an openable link **only** for `http(s)`
URLs — a stored `javascript:` URL can never become a clickable payload.

The attribution surfaces in the marker popup, the expanded sidebar row, the
time-lapse spotlight cards, and all three exports. That is what makes a
mapped point checkable: a reader can see which document put a marker on
Goma, and open it when the source was a page.

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
- **Interaction hierarchy**: area extent circles are **non-interactive**
  and render in a dedicated pane below the overlay pane. With the shared
  canvas renderer, click priority follows draw order, and every
  incremental ingest appends its new circles after previously-mounted
  point markers — a region added later would swallow clicks on every
  point inside it. Backdrop takes no pointer events; points always win.
  A region's full details are read in the sidebar list instead, whose
  rows expand (accordion, one at a time) to show the complete
  description, confidence reasoning, and parent/country — the list is
  the detail surface, the map popup is for points.

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
  slows the sweep.

  **Playback jumps between dates; it does not sweep them.**
  `computeTimelineKeyframes` (`lib/utils/shared/geo/timelineKeyframes.ts`)
  extracts the instants where the active set can actually change — a
  start, or one ms past an end (mirroring `featureVerdictAt` exactly, so
  the keyframes and what's drawn can never disagree). Every other
  position on the scale renders an identical map, so a linear sweep
  spends most of its runtime showing nothing happening. Playback visits
  only the keyframes, and the closest-together keyframes merge once the
  list exceeds 40 so a dense source can't produce an hour-long sweep. The
  slider still runs on the scale's step indices, so the thumb tracks the
  sweep and manual scrubbing stays continuous.

  **Dwell is earned, not uniform** (`lib/utils/shared/geo/timelapsePacing.ts`).
  A date's hold covers its cards opening, being read, and clearing, plus a
  capped bonus per arrival the cards couldn't cover — so a date that lands
  twenty places reads as a bigger moment than one that lands three, without
  any single date stalling the sweep. A date where nothing arrives (only
  endings) passes quickly.

  Each landing is announced by `TimelineJumpBanner` over the map: the
  date (rendered at the keyframe's own precision, so a bare `"1812"`
  never becomes "Jan 1, 1812"), how much time the jump skipped as one
  dominant unit ("214 years later"), what appeared/ended, sweep progress,
  and a **precision readout** — a five-dot meter plus a label, flagged
  `(mixed)` when the moment combines exactly-timed and vaguely-timed
  events, since the label can only show one of them. An ending is
  labelled at its last covered instant, so a March event ends in "Mar
  2026" rather than "Apr 2026".

  On the map itself, precision reads as an **uncertainty halo**: during a
  sweep a feature dated only to a month or a year wears a soft dashed ring
  (7px / 14px beyond its marker), because the sweep asserts "this is where
  things stand on this date" and a year-precision event could belong
  anywhere in that year. Day-and-finer gets no halo — at time-lapse
  resolution that is exact. The halos are non-interactive and drawn first,
  so they never intercept a click meant for their marker, and the legend
  gains an entry while a sweep is active. Simultaneously `useTimelineSpotlight` auto-opens popups for
  the arriving features — all of them when few, otherwise a sample of the
  most prominent taken at an even STRIDE through the shortlist with a
  random starting offset: cards shown at once overlap on screen, so
  drawing them from spread-apart positions stops a crowded date
  spotlighting the same neighbouring cluster three times, and the offset
  means replays surface different places. Cards open on a stagger that is
  a fraction of their lifetime, so they overlap rather than queue, and
  the keyframe's dwell is derived from their timing. The popups are added
  imperatively as plain Leaflet layers (`SpotlightPopups` in `MapView`),
  never through `map.openPopup`, so they don't close a popup the user
  opened by hand.

  **Pacing is user-configurable** — card duration (1.2–6s) and cards per
  date (1–6) — from a menu in the timeline bar (`TimelapsePacingMenu`),
  where the effect can be watched while the knobs turn. The values live in
  the settings store (`mapTimelapse`, v37), not workspace view state:
  comfortable reading speed describes the viewer, not the map. Both are
  clamped on read and on write, so a hand-edited localStorage value can't
  produce a frozen sweep. Changes take effect on the next date rather than
  restarting playback.

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
`confidence`, the event range (`eventStart`/`eventEnd`/`eventPrecision`/
`eventOngoing`; CSV: `event_start`/`event_end`/`event_precision`/
`event_ongoing`) and the source (`source`/`sourceUrl`; CSV:
`source`/`source_url`) are all carried into GeoJSON properties, the KML
description, and CSV columns, so ArcGIS/QGIS users can re-symbolize or
time-enable layers by any of them — and can trace any row back to the
material it came from. Exports are always the full (unfiltered) feature
set. Geometry in exports is still
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

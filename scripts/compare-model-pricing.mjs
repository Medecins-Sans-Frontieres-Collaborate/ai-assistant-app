#!/usr/bin/env node

/* global console, process, fetch */

/**
 * compare-model-pricing.mjs — live pricing comparison for every model in
 * config/models.json, sourced from Microsoft's Azure Retail Prices API
 * (https://prices.azure.com — the official public data source behind the
 * Azure pricing calculator; no auth required).
 *
 * For each model it prints every billing tier Azure publishes (standard /
 * priority / long-context / batch, in Global and Data Zone scopes, plus
 * cached-input reads and cache writes), a cross-model summary ranked by
 * blended price, and a drift check against the `pricing` field in
 * config/models.json.
 *
 * claude-* models have no Azure retail meters (billed through the
 * Marketplace at Anthropic's list rates), and a few legacy serverless
 * models (mistral-medium-2505, mistral-small-2503, Ministral-3B,
 * Llama-4-Scout) predate retail metering — those are reported from the
 * checked-in metadata and marked as such.
 *
 * Usage:
 *   node scripts/compare-model-pricing.mjs                  # full report (eastus2)
 *   node scripts/compare-model-pricing.mjs --region swedencentral
 *   node scripts/compare-model-pricing.mjs --model gpt-5.2-chat --model gpt-5.6-terra
 *   node scripts/compare-model-pricing.mjs --blend 4        # output:input token ratio for blended $ (default 3)
 *   node scripts/compare-model-pricing.mjs --json           # machine-readable output
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : undefined;
};
const REGION = typeof flag('region') === 'string' ? flag('region') : 'eastus2';
const AS_JSON = args.includes('--json');
const BLEND_RATIO = Number(flag('blend') ?? 3); // output tokens per input token
const MODEL_FILTER = args.reduce((acc, a, i) => {
  if (a === '--model' && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);

// ---------------------------------------------------------------------------
// Load the app's model metadata (source of truth for WHICH models to compare,
// and the baseline for the drift check).
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const modelsJson = JSON.parse(
  readFileSync(join(repoRoot, 'config', 'models.json'), 'utf8'),
);
const APP_MODELS = modelsJson.models;

// ---------------------------------------------------------------------------
// Meter matching. The Retail Prices API names meters inconsistently
// ("GPT 5.2 inp Gl", "5.2 pp inp Gl", "gpt 4o 1120 Inp glbl", "V4 Pro Inp
// DZ", ...), so each app model id maps to an include/exclude regex pair.
// Meters for fine-tuning, training, graders, hosting, provisioned
// throughput, and non-chat modalities are filtered out globally.
// ---------------------------------------------------------------------------

/** Meters that are never part of per-token chat inference pricing. */
const GLOBAL_EXCLUDE =
  /ft |ft$|-ft|FT |Finetuned|training|Trng|grader|grdr|hosting|Hstng|Provisioned|Pages|audio|aud|realtime|(^|[ -])rt([ -]|$)|img|image|embedding|tts|transcribe|search|RFT/i;

/**
 * id → { include, exclude?, note? }. `include` is tested against the meter
 * name; `exclude` prunes sibling models that share a prefix (5.2 vs 5.2
 * chat vs 5.2 codex). `note` is printed with the model's section.
 */
const METER_MATCHERS = {
  'gpt-5.2': {
    include: /^(GPT )?5\.2 /,
    exclude: /chat|codex|pro/i,
  },
  'gpt-5.2-chat': { include: /^(GPT )?5\.2 chat/i },
  'gpt-5.3-chat': { include: /^5\.3 chat/, exclude: /codex/ },
  'gpt-5.4': { include: /^5\.4 /, exclude: /nano|mini|pro/ },
  'gpt-5.4-nano': { include: /^5\.4 nano/ },
  'gpt-5.5': { include: /^5\.5 / },
  'gpt-5.6-sol': { include: /^5\.6 sol/ },
  'gpt-5.6-terra': { include: /^5\.6 terra/ },
  'gpt-5.6-luna': { include: /^5\.6 luna/ },
  'gpt-5': {
    include: /^(GPT 5 |5 pp )/,
    exclude: /Chat|Mini|Nano|pro|codex/i,
  },
  'gpt-5-chat': { include: /^GPT 5 Chat/ },
  'gpt-5-mini': { include: /^(GPT 5 Mini|5 mini pp)/i },
  'gpt-5-nano': { include: /^GPT 5 Nano/ },
  'gpt-5.1': { include: /^(GPT 5\.1 |5\.1 pp )/, exclude: /chat|codex/i },
  'gpt-5.1-chat': { include: /^GPT 5\.1 chat/i },
  'gpt-chat-latest': {
    include: /^chat-latest/,
    note: 'Rolling alias — dated meter versions all bill identically; price tracks whatever chat model Azure routes the deployment to.',
  },
  'gpt-4.1': { include: /^gpt 4\.1 (Inp|Outp|cached)/i },
  'gpt-4.1-mini': { include: /^gpt 4\.1 mini/i },
  'gpt-4.1-nano': { include: /^gpt 4\.1 nano/i },
  'gpt-4o': {
    include: /^gpt[ -]4o[ -]?(1120|0806)/i,
    note: 'Using the 1120/0806 model-version meters (equal prices); the older 0513 version bills higher ($5/$15).',
  },
  'gpt-4o-mini': { include: /^gpt[ -]4o[ -]?mini[ -]?0718/i },
  o3: { include: /^o3 0416/ },
  'o3-mini': { include: /^o3 mini 0131/ },
  'o4-mini': { include: /^o4-mini 0416/ },
  'DeepSeek-R1': { include: /^R1 / },
  'DeepSeek-R1-0528': {
    include: /^R1 /,
    note: 'No dedicated 0528 meter — billed under the shared DeepSeek R1 meters.',
  },
  'DeepSeek-V3.1': { include: /^V3\.1 / },
  'DeepSeek-V3.2': { include: /^V3\.2 /, exclude: / SP / },
  'DeepSeek-V4-Pro': { include: /^V4 Pro/ },
  'DeepSeek-V4-Flash': { include: /^V4 Flash/ },
  'Mistral-Large-3': { include: /^Large 3 / },
  'mistral-medium-3-5': { include: /^MM3\.5 / },
  'Kimi-K2.6': { include: /^K2\.6/ },
  'Llama-4-Maverick-17B-128E-Instruct-FP8': {
    include: /^Llama 4 Maverick/,
  },
  'Llama-3.3-70B-Instruct': { include: /^Llama 3\.3 70B/ },
  'grok-3': { include: /^Grok-3 /, exclude: /Mini/ },
  'grok-3-mini': { include: /^Grok-3 Mini/ },
  'grok-4': { include: /^Grok-4 / },
  'grok-4-1-fast-reasoning': {
    include: /^Grok 4\.1 /,
    note: 'Azure bills one "Grok 4.1" (fast) meter for both reasoning and non-reasoning variants.',
  },
  'grok-4-1-fast-non-reasoning': {
    include: /^Grok 4\.1 /,
    note: 'Azure bills one "Grok 4.1" (fast) meter for both reasoning and non-reasoning variants.',
  },
};

/** Models with no Azure retail meters, reported from checked-in metadata. */
const NO_METER_REASON = {
  anthropic:
    'Billed via Azure Marketplace at Anthropic list rates — not in the Azure Retail Prices API.',
  legacyServerless:
    'Legacy serverless (Marketplace) billing — no retail meter; published serverless list rate from config/models.json.',
};
const LEGACY_SERVERLESS = new Set([
  'mistral-medium-2505',
  'mistral-small-2503',
  'Ministral-3B',
  'Llama-4-Scout-17B-16E-Instruct',
]);

// ---------------------------------------------------------------------------
// Meter classification: direction × scope × tier.
// ---------------------------------------------------------------------------

function classifyMeter(name) {
  // Word-boundary matching throughout: meter names mix spaces and hyphens
  // ("GPT 5.2 cd inp Gl" vs "gpt-4o-mini-0718-Inp-glbl"), and substrings
  // betray ("Batch inp" contains "ch inp"; "Batch" contains "bat").
  // Order matters: "Cd Wr" would otherwise match the cached-input patterns.
  const direction = /\bCd Wr\b/i.test(name)
    ? 'cacheWrite'
    : /\b(cchd|cached|cd|ch)\b/i.test(name)
      ? 'cachedInput'
      : /\b(inp|inpt|input)\b/i.test(name)
        ? 'input'
        : /\b(outp|outpt|opt|out|output)\b/i.test(name)
          ? 'output'
          : null;

  const scope = /\b(dz|dzone)\b|data ?zone/i.test(name)
    ? 'dataZone'
    : /\b(regnl|rgnl|regional|regn)\b/i.test(name)
      ? 'regional'
      : 'global'; // "glbl"/"Gl"/"global", and older 3P meters with no scope token

  const isBatch = /\b(batch|bat)\b/i.test(name);
  const isLong = /longco/i.test(name);
  const tier = isBatch
    ? isLong
      ? 'batchLongContext'
      : 'batch'
    : isLong
      ? 'longContext'
      : /\bpp\b/i.test(name)
        ? 'priority'
        : 'standard';

  return { direction, scope, tier };
}

// ---------------------------------------------------------------------------
// Fetch all Foundry Models meters for the region (paginated).
// ---------------------------------------------------------------------------

async function fetchMeters(region) {
  const filter = `serviceName eq 'Foundry Models' and armRegionName eq '${region}' and type eq 'Consumption'`;
  let url = `https://prices.azure.com/api/retail/prices?currencyCode=USD&$filter=${encodeURIComponent(filter)}`;
  const items = [];
  while (url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Retail Prices API ${res.status}: ${await res.text()}`);
    }
    const page = await res.json();
    items.push(...page.Items);
    url = page.NextPageLink;
  }
  return items;
}

/** Normalize a meter's unit price to USD per 1M tokens. */
function per1M(item) {
  if (item.unitOfMeasure === '1M') return item.unitPrice;
  if (item.unitOfMeasure === '1K') return item.unitPrice * 1000;
  return null; // hours, pages, ... — not token-priced
}

// ---------------------------------------------------------------------------
// Build the per-model pricing structure.
// ---------------------------------------------------------------------------

function collectModelPricing(meters, matcher) {
  // rates[tier][scope][direction] = { price, meters: [names] }
  const rates = {};
  const matched = [];
  for (const m of meters) {
    const name = m.meterName;
    if (GLOBAL_EXCLUDE.test(name)) continue;
    if (!matcher.include.test(name)) continue;
    if (matcher.exclude && matcher.exclude.test(name)) continue;
    const price = per1M(m);
    if (price == null) continue;
    const { direction, scope, tier } = classifyMeter(name);
    if (!direction) continue;
    matched.push({ name, price, effective: m.effectiveStartDate });
    rates[tier] ??= {};
    rates[tier][scope] ??= {};
    const slot = (rates[tier][scope][direction] ??= {
      price,
      meters: [],
    });
    if (!slot.meters.includes(name)) slot.meters.push(name);
    if (slot.price !== price) {
      // Conflicting prices for the same slot (e.g. two model versions):
      // keep the lower/newer and record the conflict for display.
      slot.conflict = slot.conflict ?? [slot.price];
      slot.conflict.push(price);
      slot.price = Math.min(slot.price, price);
    }
  }
  return { rates, matched };
}

// ---------------------------------------------------------------------------
// Rendering helpers.
// ---------------------------------------------------------------------------

/** Float-safe price comparison (API values arrive via 1K→1M multiplication). */
const differs = (a, b) => Math.abs(a - b) > 1e-6;

const usd = (n) =>
  n == null
    ? '—'
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);

const TIER_LABEL = {
  standard: 'Standard',
  priority: 'Priority processing',
  longContext: 'Long context',
  batch: 'Batch',
  batchLongContext: 'Batch (long context)',
};
const SCOPE_LABEL = {
  global: 'Global',
  dataZone: 'Data Zone',
  regional: 'Regional',
};

function renderModelSection(id, model, result, lines) {
  const meta = model.pricing;
  lines.push('');
  lines.push(`── ${id} ${'─'.repeat(Math.max(2, 74 - id.length))}`);
  lines.push(
    `   ${model.name}  ·  provider: ${model.provider}  ·  sdk: ${model.sdk ?? '—'}` +
      (model.isDisabled ? '  ·  DISABLED in app' : ''),
  );
  if (result.note) lines.push(`   note: ${result.note}`);

  if (!result.rates || Object.keys(result.rates).length === 0) {
    lines.push(
      `   ${result.reason ?? 'No token meters found in this region.'}`,
    );
    if (meta) {
      lines.push(
        `   List rate (config/models.json): input ${usd(meta.inputPer1M)}  output ${usd(
          meta.outputPer1M,
        )}${meta.cachedInputPer1M != null ? `  cached-in ${usd(meta.cachedInputPer1M)}` : ''}  per 1M tokens`,
      );
    }
    return;
  }

  lines.push(
    `   ${pad('Tier', 22)}${pad('Scope', 11)}${rpad('Input', 10)}${rpad(
      'Cached-in',
      11,
    )}${rpad('Output', 10)}${rpad('CacheWrite', 12)}   (USD per 1M tokens)`,
  );
  const tierOrder = [
    'standard',
    'priority',
    'longContext',
    'batch',
    'batchLongContext',
  ];
  const scopeOrder = ['global', 'dataZone', 'regional'];
  for (const tier of tierOrder) {
    if (!result.rates[tier]) continue;
    for (const scope of scopeOrder) {
      const r = result.rates[tier][scope];
      if (!r) continue;
      lines.push(
        `   ${pad(TIER_LABEL[tier], 22)}${pad(SCOPE_LABEL[scope], 11)}${rpad(
          usd(r.input?.price),
          10,
        )}${rpad(usd(r.cachedInput?.price), 11)}${rpad(usd(r.output?.price), 10)}${rpad(
          usd(r.cacheWrite?.price),
          12,
        )}`,
      );
      for (const dir of ['input', 'output', 'cachedInput', 'cacheWrite']) {
        if (r[dir]?.conflict) {
          lines.push(
            `      ⚠ multiple ${dir} meter prices matched (${r[dir].conflict
              .map(usd)
              .join(
                ', ',
              )}) — showing lowest; meters: ${r[dir].meters.join(' | ')}`,
          );
        }
      }
    }
  }

  // Drift check against checked-in metadata (Global standard is the baseline).
  const std = result.rates.standard?.global;
  if (meta && std?.input && std?.output) {
    const drift = [];
    if (differs(std.input.price, meta.inputPer1M))
      drift.push(`input ${usd(meta.inputPer1M)} → ${usd(std.input.price)}`);
    if (differs(std.output.price, meta.outputPer1M))
      drift.push(`output ${usd(meta.outputPer1M)} → ${usd(std.output.price)}`);
    if (
      meta.cachedInputPer1M != null &&
      std.cachedInput &&
      differs(std.cachedInput.price, meta.cachedInputPer1M)
    )
      drift.push(
        `cached-in ${usd(meta.cachedInputPer1M)} → ${usd(std.cachedInput.price)}`,
      );
    lines.push(
      drift.length
        ? `   ✗ DRIFT vs config/models.json: ${drift.join(', ')}`
        : `   ✓ matches config/models.json pricing`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const modelIds = Object.keys(APP_MODELS).filter(
    (id) => MODEL_FILTER.length === 0 || MODEL_FILTER.includes(id),
  );
  if (modelIds.length === 0) {
    console.error(`No models matched ${MODEL_FILTER.join(', ')}`);
    process.exit(1);
  }

  console.error(`Fetching Azure Retail Prices for region '${REGION}'…`);
  const meters = await fetchMeters(REGION);
  console.error(`  ${meters.length} consumption meters retrieved.\n`);

  const results = {};
  for (const id of modelIds) {
    const model = APP_MODELS[id];
    if (model.provider === 'anthropic') {
      results[id] = { rates: null, reason: NO_METER_REASON.anthropic };
    } else if (LEGACY_SERVERLESS.has(id)) {
      results[id] = { rates: null, reason: NO_METER_REASON.legacyServerless };
    } else if (METER_MATCHERS[id]) {
      const { rates, matched } = collectModelPricing(
        meters,
        METER_MATCHERS[id],
      );
      results[id] = {
        rates,
        matched,
        note: METER_MATCHERS[id].note,
        reason:
          matched.length === 0
            ? 'No meters matched — model may not be retail-priced in this region.'
            : undefined,
      };
    } else {
      results[id] = {
        rates: null,
        reason: 'No meter matcher defined for this id.',
      };
    }
  }

  if (AS_JSON) {
    const out = {};
    for (const id of modelIds) {
      // Destructure `matched` out — the raw meter list is noise in JSON output.
      // eslint-disable-next-line no-unused-vars
      const { matched, ...rest } = results[id];
      out[id] = {
        ...rest,
        metadataPricing: APP_MODELS[id].pricing ?? null,
        provider: APP_MODELS[id].provider,
      };
    }
    console.log(
      JSON.stringify(
        { region: REGION, fetchedAt: new Date().toISOString(), models: out },
        null,
        2,
      ),
    );
    return;
  }

  const lines = [];
  lines.push(`Azure model pricing — region '${REGION}', USD per 1M tokens`);
  lines.push(
    `Source: Azure Retail Prices API (prices.azure.com), pay-as-you-go list prices; fetched ${new Date().toISOString().slice(0, 10)}.`,
  );
  lines.push(
    `claude-* and legacy serverless models are Marketplace-billed (no retail meters) and shown from config/models.json list rates.`,
  );

  // ---- Summary table (Global standard), ranked by blended price -----------
  const summary = modelIds
    .map((id) => {
      const std = results[id].rates?.standard?.global;
      const meta = APP_MODELS[id].pricing;
      const input = std?.input?.price ?? meta?.inputPer1M ?? null;
      const output = std?.output?.price ?? meta?.outputPer1M ?? null;
      const cached = std?.cachedInput?.price ?? meta?.cachedInputPer1M ?? null;
      const live = !!(std?.input && std?.output);
      const blended =
        input != null && output != null
          ? (input + BLEND_RATIO * output) / (1 + BLEND_RATIO)
          : null;
      return { id, input, output, cached, blended, live };
    })
    .filter((r) => r.blended != null)
    .sort((a, b) => a.blended - b.blended);

  lines.push('');
  lines.push(
    `SUMMARY — Global standard, ranked by blended price (1 input : ${BLEND_RATIO} output tokens)`,
  );
  lines.push(
    `${pad('Model', 42)}${rpad('Input', 10)}${rpad('Cached-in', 11)}${rpad('Output', 10)}${rpad('Blended', 10)}  Src`,
  );
  for (const r of summary) {
    lines.push(
      `${pad(r.id, 42)}${rpad(usd(r.input), 10)}${rpad(usd(r.cached), 11)}${rpad(
        usd(r.output),
        10,
      )}${rpad(usd(r.blended), 10)}  ${r.live ? 'live' : 'list'}`,
    );
  }

  // ---- Per-model detail ----------------------------------------------------
  for (const id of modelIds) {
    renderModelSection(id, APP_MODELS[id], results[id], lines);
  }

  // ---- Drift summary -------------------------------------------------------
  const drifted = [];
  for (const id of modelIds) {
    const std = results[id].rates?.standard?.global;
    const meta = APP_MODELS[id].pricing;
    if (!std?.input || !std?.output || !meta) continue;
    if (
      differs(std.input.price, meta.inputPer1M) ||
      differs(std.output.price, meta.outputPer1M) ||
      (meta.cachedInputPer1M != null &&
        std.cachedInput &&
        differs(std.cachedInput.price, meta.cachedInputPer1M))
    )
      drifted.push(id);
  }
  lines.push('');
  lines.push(
    drifted.length
      ? `DRIFT CHECK: ${drifted.length} model(s) differ from config/models.json → ${drifted.join(', ')}`
      : `DRIFT CHECK: all live-priced models match config/models.json.`,
  );

  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

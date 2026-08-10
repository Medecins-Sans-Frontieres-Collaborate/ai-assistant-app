/**
 * Builds the model / model-family choices for the limits admin picker.
 *
 * Pure and dependency-light so it can be unit-tested under the node config.
 * (A test file under `__tests__/components/` with a `.ts` extension is matched
 * by NEITHER vitest config and would silently never run — hence this lives in
 * lib/.)
 */
import { OpenAIModel } from '@/types/openai';

export interface FamilyChoice {
  /** The `series` value stored on a limit entry. */
  series: string;
  label: string;
  /** Model ids that declare this series — shown as the family's members. */
  modelIds: string[];
}

export interface ModelChoice {
  modelId: string;
  label: string;
  series?: string;
}

export interface QualifierCatalog {
  families: FamilyChoice[];
  models: ModelChoice[];
}

/**
 * `series` is OPTIONAL on OpenAIModel. A model that declares none produces no
 * family choice and is never folded into another family — matching the
 * resolver, which emits no `family:` cell for such a model.
 */
export function buildQualifierCatalog(models: OpenAIModel[]): QualifierCatalog {
  const families = new Map<string, FamilyChoice>();
  const choices: ModelChoice[] = [];

  for (const model of models) {
    if (!model.id) continue;
    choices.push({
      modelId: model.id,
      label: model.name || model.id,
      ...(model.series ? { series: model.series } : {}),
    });

    if (!model.series) continue;
    const existing = families.get(model.series);
    if (existing) {
      existing.modelIds.push(model.id);
    } else {
      families.set(model.series, {
        series: model.series,
        label: model.seriesLabel || model.series,
        modelIds: [model.id],
      });
    }
  }

  const byLabel = (a: { label: string }, b: { label: string }) =>
    a.label.localeCompare(b.label);

  return {
    families: [...families.values()].sort(byLabel),
    models: choices.sort(byLabel),
  };
}

/**
 * Is this stored qualifier absent from the catalog the admin is looking at?
 *
 * Model ids come from live Foundry discovery and vary per ring and region, so
 * a limit pinned to a model this ring does not serve is EXPECTED, not
 * corruption — write validation is shape-only for exactly that reason. The UI
 * annotates it rather than pruning or disabling it.
 */
export function isUnknownQualifier(
  catalog: QualifierCatalog,
  qualifier: { modelId?: string; series?: string },
): boolean {
  if (qualifier.modelId) {
    return !catalog.models.some(
      (m) => m.modelId.toLowerCase() === qualifier.modelId!.toLowerCase(),
    );
  }
  if (qualifier.series) {
    return !catalog.families.some(
      (f) => f.series.toLowerCase() === qualifier.series!.toLowerCase(),
    );
  }
  return false;
}

/** Human label for a stored qualifier, falling back to the raw id. */
export function qualifierLabel(
  catalog: QualifierCatalog,
  qualifier: { modelId?: string; series?: string },
): string {
  if (qualifier.modelId) {
    const match = catalog.models.find(
      (m) => m.modelId.toLowerCase() === qualifier.modelId!.toLowerCase(),
    );
    return match?.label ?? qualifier.modelId;
  }
  if (qualifier.series) {
    const match = catalog.families.find(
      (f) => f.series.toLowerCase() === qualifier.series!.toLowerCase(),
    );
    return match?.label ?? qualifier.series;
  }
  return '';
}

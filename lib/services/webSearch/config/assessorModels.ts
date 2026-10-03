/**
 * Which catalog models may serve as the search assessor.
 *
 * The assessor is called through the Foundry OpenAI-compatible endpoint with
 * a JSON response, between search steps, while the user is waiting. That
 * rules out: Claude models (a different SDK), dedicated reasoners (tens of
 * seconds of hidden thinking per step), agent wrappers, and anything
 * disabled or past its lifecycle.
 */
import { OpenAIModel, OpenAIModels } from '@/types/openai';

export interface AssessorModelOption {
  id: string;
  name: string;
}

function isAssessorCapable(model: OpenAIModel): boolean {
  return (
    (model.sdk === 'azure-openai' || model.sdk === 'openai') &&
    !model.isDisabled &&
    !model.isAgent &&
    !model.isCustomSourceModel &&
    model.modelType !== 'reasoning' &&
    model.lifecycle !== 'retired' &&
    model.lifecycle !== 'deprecated'
  );
}

/** Catalog config for an assessor-capable model id, else undefined. */
export function findAssessorModel(id: string): OpenAIModel | undefined {
  const model = (OpenAIModels as Record<string, OpenAIModel | undefined>)[id];
  return model && isAssessorCapable(model) ? model : undefined;
}

export function isAllowedAssessorModel(id: string): boolean {
  return findAssessorModel(id) !== undefined;
}

/** The choices the admin panel offers, by display name. */
export function listAssessorModels(): AssessorModelOption[] {
  return Object.values(OpenAIModels)
    .filter(isAssessorCapable)
    .map((model) => ({ id: model.id, name: model.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

import { OpenAIModel } from '@/types/openai';

// Type for next-intl translator function
type TranslatorFunction = (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

/**
 * Sanitize model ID for use in translation keys
 * Replaces periods with hyphens to avoid nested object interpretation
 */
function sanitizeModelId(modelId: string): string {
  return modelId.replace(/\./g, '-');
}

/**
 * Get translated model description
 * @param modelId - The model ID
 * @param t - Translation function from next-intl
 * @returns Translated description or fallback to original
 */
export function getTranslatedModelDescription(
  modelId: string,
  t: TranslatorFunction,
): string {
  const sanitizedId = sanitizeModelId(modelId);
  const translationKey = `models.${sanitizedId}.description`;

  try {
    const translated = t(translationKey);
    // If translation key is returned as-is, it means no translation exists
    // In that case, return empty string and let the component use the default
    if (translated === translationKey) {
      return '';
    }
    return translated;
  } catch (error) {
    return '';
  }
}

/**
 * Get translated model type label
 * @param modelType - The model type
 * @param t - Translation function from next-intl
 * @returns Translated model type
 */
export function getTranslatedModelType(
  modelType: 'foundational' | 'omni' | 'reasoning' | 'agent',
  t: TranslatorFunction,
): string {
  const translationKey = `models.modelTypes.${modelType}`;

  try {
    const translated = t(translationKey);
    // Return capitalized version as fallback
    if (translated === translationKey) {
      return modelType.charAt(0).toUpperCase() + modelType.slice(1);
    }
    return translated;
  } catch (error) {
    return modelType.charAt(0).toUpperCase() + modelType.slice(1);
  }
}

/**
 * Get translated knowledge cutoff label
 * @param t - Translation function from next-intl
 * @returns Translated "Knowledge cutoff" text
 */
export function getKnowledgeCutoffLabel(t: TranslatorFunction): string {
  try {
    return t('models.ui.knowledgeCutoff');
  } catch (error) {
    return 'Knowledge cutoff';
  }
}

/**
 * Get translated "Back to Models" text
 * @param t - Translation function from next-intl
 * @returns Translated text
 */
export function getBackToModelsLabel(t: TranslatorFunction): string {
  try {
    return t('models.ui.backToModels');
  } catch (error) {
    return 'Back to Models';
  }
}

/**
 * Get translated search mode labels
 */
export function getSearchModeLabels(t: TranslatorFunction) {
  return {
    searchMode: t('models.ui.searchMode'),
    searchModeDescription: t('models.ui.searchModeDescription'),
    privacyFocusedDefault: t('models.ui.privacyFocusedDefault'),
    privacyFocusedDescription: t('models.ui.privacyFocusedDescription'),
    azureAIAgentMode: t('models.ui.azureAIAgentMode'),
    azureAIAgentModeDescription: t('models.ui.azureAIAgentModeDescription'),
    importantPrivacyInformation: t('models.ui.importantPrivacyInformation'),
    fullConversationSentWarning: t('models.ui.fullConversationSentWarning'),
    learnMoreDataStorage: t('models.ui.learnMoreDataStorage'),
    searchRouting: t('models.ui.searchRouting'),
    whatIsTheDifference: t('models.ui.whatIsTheDifference'),
    realTimeWebSearch: t('models.ui.realTimeWebSearch'),
  };
}

/**
 * Get translated advanced settings labels
 */
export function getAdvancedSettingsLabels(t: TranslatorFunction) {
  return {
    advancedOptions: t('models.ui.advancedOptions'),
    temperature: t('Temperature'),
    temperatureNote: t('models.ui.temperatureNote'),
    reasoningEffort: t('models.advancedSettings.reasoningEffort'),
    reasoningEffortDescription: t(
      'models.advancedSettings.reasoningEffortDescription',
    ),
    minimal: t('models.advancedSettings.minimal'),
    minimalDescription: t('models.advancedSettings.minimalDescription'),
    low: t('models.advancedSettings.low'),
    lowDescription: t('models.advancedSettings.lowDescription'),
    medium: t('models.advancedSettings.medium'),
    mediumDescription: t('models.advancedSettings.mediumDescription'),
    high: t('models.advancedSettings.high'),
    highDescription: t('models.advancedSettings.highDescription'),
    verbosity: t('models.advancedSettings.verbosity'),
    verbosityDescription: t('models.advancedSettings.verbosityDescription'),
    verbosityLow: t('models.advancedSettings.verbosityLow'),
    verbosityMedium: t('models.advancedSettings.verbosityMedium'),
    verbosityHigh: t('models.advancedSettings.verbosityHigh'),
  };
}

/**
 * Get localized model with translated description
 * @param model - The model object
 * @param t - Translation function from next-intl
 * @returns Model with translated description if available
 */
export function getLocalizedModel(
  model: OpenAIModel,
  t: TranslatorFunction,
): OpenAIModel {
  const translatedDescription = getTranslatedModelDescription(model.id, t);

  return {
    ...model,
    description: translatedDescription || model.description,
  };
}

/** Trusted account bindings and processing-zone checks. No client-supplied URLs. */
import {
  isValidFoundryResourcePath,
  stripToAccountPath,
} from '@/lib/utils/shared/armPath';

import type { AuxiliaryAccount, AuxiliaryBinding } from './types';

import { env } from '@/config/environment';

// Azure regions in the EU data zone. Keep location evidence distinct from SKU evidence.
const EU_LOCATIONS = new Set([
  'swedencentral',
  'swedensouth',
  'westeurope',
  'northeurope',
  'francecentral',
  'francesouth',
  'germanywestcentral',
  'germanynorth',
  'polandcentral',
  'italynorth',
  'spaincentral',
  'austriaeast',
  'belgiumcentral',
  'finlandcentral',
  'denmarkeast',
]);

/** True only for a verified EU location and a regional/EU data-zone SKU. */
export function isEuProcessing(location?: string, sku?: string): boolean {
  return (
    !!location &&
    EU_LOCATIONS.has(location.toLowerCase()) &&
    (sku === 'DataZoneStandard' ||
      sku === 'DataZoneProvisionedManaged' ||
      sku === 'Standard' ||
      sku === 'ProvisionedManaged')
  );
}

/** Normalize the configured deployment environment; prod and live share identity. */
export function auxiliaryEnvironment(): string {
  return env.NEXT_PUBLIC_ENV === 'prod' ? 'live' : env.NEXT_PUBLIC_ENV;
}

/** Resolve a binding from validated server configuration, checking account identity. */
export function auxiliaryAccount(binding: AuxiliaryBinding): AuxiliaryAccount {
  const foundry =
    binding === 'EU'
      ? env.AZURE_AI_FOUNDRY_ENDPOINT_EU
      : binding === 'US'
        ? env.AZURE_AI_FOUNDRY_ENDPOINT_US
        : env.AZURE_AI_FOUNDRY_ENDPOINT;
  const azure =
    binding === 'EU'
      ? env.AZURE_OPENAI_ENDPOINT_EU
      : binding === 'US'
        ? env.AZURE_OPENAI_ENDPOINT_US
        : env.AZURE_OPENAI_ENDPOINT;
  const rawPath =
    binding === 'EU'
      ? env.AZURE_AI_FOUNDRY_RESOURCE_ID_EU
      : binding === 'US'
        ? env.AZURE_AI_FOUNDRY_RESOURCE_ID_US
        : (env.AZURE_AI_FOUNDRY_RESOURCE_ID ??
          env.AZURE_AI_FOUNDRY_RESOURCE_ID_US);
  const result: AuxiliaryAccount = { binding, configured: false };
  if (!rawPath || !isValidFoundryResourcePath(rawPath))
    return { ...result, error: 'account_resource_missing' };
  const resourcePath = stripToAccountPath(rawPath);
  const endpoint = foundry
    ? `${foundry.replace(/\/api\/projects\/.*$/, '').replace(/\/$/, '')}/openai/v1/`
    : azure;
  if (!endpoint) return { ...result, resourcePath, error: 'endpoint_missing' };
  const url = new URL(endpoint);
  const name = resourcePath.split('/').at(-1)?.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    ![
      `${name}.services.ai.azure.com`,
      `${name}.cognitiveservices.azure.com`,
      `${name}.openai.azure.com`,
    ].includes(url.hostname.toLowerCase())
  ) {
    return { ...result, resourcePath, error: 'endpoint_account_mismatch' };
  }
  if (
    binding === 'default' &&
    env.AZURE_AI_FOUNDRY_OPENAI_ENDPOINT &&
    env.AZURE_AI_FOUNDRY_OPENAI_ENDPOINT.replace(/\/$/, '') !==
      endpoint.replace(/\/$/, '')
  ) {
    return { ...result, resourcePath, error: 'endpoint_account_mismatch' };
  }
  return { binding, resourcePath, endpoint, configured: true };
}

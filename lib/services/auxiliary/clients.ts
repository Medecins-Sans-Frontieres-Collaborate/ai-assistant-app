/** Lazily constructed auxiliary clients bound only to validated server accounts. */
import { auxiliaryAccount } from './bindings';
import type { AuxiliaryBinding } from './types';

import { env } from '@/config/environment';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import OpenAI, { AzureOpenAI } from 'openai';

/** Prefer app Entra credentials; retain the configured account key only if token acquisition fails. */
export function createEntraPreferredFetch(
  tokenProvider: () => Promise<string>,
): typeof fetch {
  return async (input, init) => {
    let token: string;
    try {
      token = await tokenProvider();
    } catch {
      console.warn(
        '[auxiliary] Entra token unavailable; using configured account-key fallback',
      );
      return fetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

/** Build clients on first inference use, so missing chat defaults cannot prevent environmental diagnostics. */
export function auxiliaryClientResolver(
  credential: DefaultAzureCredential,
): (binding: AuxiliaryBinding) => OpenAI | undefined {
  const clients = new Map<AuxiliaryBinding, OpenAI>();
  const tokenProvider = getBearerTokenProvider(
    credential,
    'https://cognitiveservices.azure.com/.default',
  );
  return (binding) => {
    const cached = clients.get(binding);
    if (cached) return cached;
    const account = auxiliaryAccount(binding);
    if (!account.configured || !account.endpoint) return undefined;
    const key =
      binding === 'EU'
        ? env.OPENAI_API_KEY_EU
        : binding === 'US'
          ? env.OPENAI_API_KEY_US
          : env.OPENAI_API_KEY;
    const client = account.endpoint.endsWith('/openai/v1/')
      ? new OpenAI({
          baseURL: account.endpoint,
          apiKey: key || 'placeholder',
          fetch: createEntraPreferredFetch(tokenProvider),
        })
      : new AzureOpenAI({
          endpoint: account.endpoint,
          apiKey: '',
          baseURL: '',
          azureADTokenProvider: tokenProvider,
          apiVersion: env.OPENAI_API_VERSION,
        });
    clients.set(binding, client);
    return client;
  };
}

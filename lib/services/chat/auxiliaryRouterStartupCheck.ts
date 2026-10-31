/**
 * Boot-time rehearsal of the region-pinned auxiliary router
 * (ToolRouterService). Since residency pinning, EU users (and users of
 * unknown region) route every tool/skill decision through the EU endpoint
 * with no fallback, so a region whose Foundry account lacks the
 * AUXILIARY_ROUTER_MODEL deployment — or where the app identity has no
 * data-plane role — loses web search, code execution and skill selection
 * for everyone it serves. Per request that surfaces only as a one-line
 * "Tool routing unavailable" marker; this check announces it at startup
 * with the remedy. Warn-only, fire-and-forget, never fatal.
 */
import { ServiceContainer } from '@/lib/services/ServiceContainer';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import type { UserRegion } from '@/lib/utils/shared/region';

import {
  AUXILIARY_ROUTER_MODEL,
  describeAuxiliaryFailure,
} from './ToolRouterService';

import type OpenAI from 'openai';

export type AuxiliaryClient = Pick<OpenAI, 'chat'>;

export interface AuxiliaryRouterCheckDeps {
  /** The client a region-pinned routing call would use; undefined = none configured. */
  getClient: (region: UserRegion) => AuxiliaryClient | undefined;
  /** Minimal completion against the router model; rejects on any failure. */
  probe?: (client: AuxiliaryClient) => Promise<void>;
  log?: Pick<Console, 'log' | 'warn'>;
}

const REGIONS: readonly UserRegion[] = ['US', 'EU'];

export async function defaultProbe(client: AuxiliaryClient): Promise<void> {
  await client.chat.completions.create(
    {
      model: AUXILIARY_ROUTER_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      // Same shape as the router's real call, so a deployment that rejects
      // the parameter fails here instead of on the first user turn.
      reasoning_effort: 'minimal',
      max_completion_tokens: 16,
    },
    { timeout: 15_000, maxRetries: 0 },
  );
}

export function defaultGetClient(
  region: UserRegion,
): AuxiliaryClient | undefined {
  const container = ServiceContainer.getInstance();
  const regional = container.getChatClientsForRegion(region);
  const client = regional.openAIClient ?? regional.azureOpenAIClient;
  // Mirrors ToolRouterService.clientFor: a US pin without a US client uses
  // the default set; EU never falls back.
  if (!client && region === 'US') return container.getOpenAIClient();
  return client;
}

/** Returns per-region outcomes (for tests); logs each as it resolves. */
export async function checkAuxiliaryRouterEndpoints(
  deps: AuxiliaryRouterCheckDeps,
): Promise<Record<UserRegion, 'ok' | 'missing' | 'failed'>> {
  const log = deps.log ?? console;
  const probe = deps.probe ?? defaultProbe;
  const outcomes = { US: 'ok', EU: 'ok' } as Record<
    UserRegion,
    'ok' | 'missing' | 'failed'
  >;
  await Promise.all(
    REGIONS.map(async (region) => {
      const client = deps.getClient(region);
      if (!client) {
        outcomes[region] = 'missing';
        log.warn(
          `[tool-router] No ${region} auxiliary endpoint configured — tool routing, skill selection and document-trim classification for ${region}-pinned users will degrade to "no tools" on every turn (EU never falls back to the default endpoints). Set AZURE_AI_FOUNDRY_ENDPOINT_${region} (or AZURE_OPENAI_ENDPOINT_${region}), or AZURE_DEFAULT_REGION=${region} when the default endpoints live there.`,
        );
        return;
      }
      try {
        await probe(client);
        log.log(
          `[tool-router] ${region} auxiliary endpoint can serve ${AUXILIARY_ROUTER_MODEL}`,
        );
      } catch (error) {
        outcomes[region] = 'failed';
        const failure = describeAuxiliaryFailure(error, region);
        log.warn(
          `[tool-router] ${region} auxiliary endpoint FAILED the startup check (${failure.reason}) — ${region}-pinned users will get "Tool routing unavailable" on every turn: ${sanitizeForLog(failure.message)}`,
        );
      }
    }),
  );
  return outcomes;
}

/** Instrumentation entry point: skipped in tests, never throws. */
export async function logAuxiliaryRouterStartupWarnings(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  try {
    await checkAuxiliaryRouterEndpoints({ getClient: defaultGetClient });
  } catch (error) {
    console.warn(
      `[tool-router] auxiliary endpoint startup check skipped: ${sanitizeForLog(error)}`,
    );
  }
}

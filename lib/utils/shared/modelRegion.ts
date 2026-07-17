import { OpenAIModel } from '@/types/openai';

import { UserRegion } from './region';

/**
 * Whether a model can be chatted with from the user's region.
 *
 * US users can use ANY discovered model: cross-region routing lets a US
 * conversation target the EU instance of an EU-hosted model (data flowing
 * US → EU is fine). EU users are the residency-constrained direction: they
 * may only use models hosted in the EU, and the server independently forces
 * their chat traffic to EU endpoints (resolveChatRegion below).
 *
 * Deliberately permissive on missing data:
 *  - No `hostedIn` (static list / fallback) → selectable. The static list is
 *    region-blind; gating it would regress current behavior.
 *  - No region (session not loaded yet) → selectable. Don't lock the picker
 *    while auth hydrates.
 */
export function isModelSelectableInRegion(
  model: Pick<OpenAIModel, 'hostedIn'>,
  region: UserRegion | null | undefined,
): boolean {
  if (!model.hostedIn || model.hostedIn.length === 0) return true;
  if (!region || region === 'US') return true;
  return model.hostedIn.includes('EU');
}

/**
 * Resolves which region a chat request should be routed to.
 *
 * Server-side residency enforcement: an EU user is ALWAYS routed to EU
 * regardless of what the client requested — the UI never gets to opt EU data
 * out. A US user gets their requested region ('EU' to use an EU-hosted
 * instance), or `null` when no preference was sent. `null` means "use the
 * default client set", which is bit-for-bit the pre-cross-region behavior.
 */
export function resolveChatRegion(
  userRegion: UserRegion | null | undefined,
  requested: UserRegion | null | undefined,
): UserRegion | null {
  if (userRegion === 'EU') return 'EU';
  return requested ?? null;
}

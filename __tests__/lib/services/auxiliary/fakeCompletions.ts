/**
 * Test seam for helper-model callers: installs a shared
 * AuxiliaryCompletionService whose "auxiliary chain" is a fake client, so a
 * suite drives replies with `create` and asserts the residency region each
 * call was routed to. Call the returned `restore` in afterEach.
 */
import {
  AuxiliaryCompletionService,
  setAuxiliaryCompletionsForTests,
} from '@/lib/services/auxiliary/auxiliaryCompletion';
import type { AuxiliaryRegion } from '@/lib/services/auxiliary/types';

import type OpenAI from 'openai';
import { type Mock, vi } from 'vitest';

export interface FakeAuxiliaryCompletions {
  /** The fake chain's `chat.completions.create`. */
  create: Mock;
  /** The region each call was routed to, in call order. */
  regions: AuxiliaryRegion[];
  /** Removes the fake (restores the production service). */
  restore: () => void;
}

/**
 * Installs the fake. Replies default to `undefined` (a rejected reply);
 * set them with `create.mockResolvedValue(...)`.
 *
 * @param create - Optionally, an existing mock to use as the chain.
 */
export function installFakeAuxiliaryCompletions(
  create: Mock = vi.fn(),
): FakeAuxiliaryCompletions {
  const regions: AuxiliaryRegion[] = [];
  const service = new AuxiliaryCompletionService(undefined, (region) => {
    regions.push(region);
    return { chat: { completions: { create } } } as unknown as OpenAI;
  });
  setAuxiliaryCompletionsForTests(service);
  return {
    create,
    regions,
    restore: () => setAuxiliaryCompletionsForTests(undefined),
  };
}

/** A completion whose content is `value` as JSON. */
export function jsonReply(value: unknown) {
  return { choices: [{ message: { content: JSON.stringify(value) } }] };
}

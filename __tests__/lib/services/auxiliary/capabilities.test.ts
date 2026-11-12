/**
 * Capability contracts: declared per operation, read from model metadata,
 * implied by request content, and used to decide which operations a model
 * is held to.
 */
import {
  countRequestTokens,
  missingCapability,
  modelCapabilities,
  requiredCapabilities,
} from '@/lib/services/auxiliary/capabilities';
import {
  ROUTING_OPERATIONS,
  operationsServed,
  servesOperation,
} from '@/lib/services/auxiliary/types';

import { IMAGE_TOKENS_HIGH_DETAIL } from '@/lib/utils/server/chat/chat';

import { OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

const textRequest = {
  model: '',
  messages: [{ role: 'user' as const, content: 'hello' }],
};
const imageRequest = {
  model: '',
  messages: [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'hello' },
        {
          type: 'image_url' as const,
          image_url: { url: `data:image/png;base64,${'A'.repeat(200_000)}` },
        },
      ],
    },
  ],
};

describe('auxiliary capabilities', () => {
  it('reads vision from model metadata', () => {
    const vision = Object.values(OpenAIModels).find(
      (model) => model.supportsVision === true,
    )!;
    const textOnly = Object.values(OpenAIModels).find(
      (model) => !model.supportsVision,
    )!;
    expect(modelCapabilities(vision)).toEqual(['vision']);
    expect(modelCapabilities(textOnly)).toEqual([]);
    expect(missingCapability(textOnly, ['vision'])).toBe('vision');
    expect(missingCapability(vision, ['vision'])).toBeUndefined();
  });

  it('requires vision for the vision operation and for any image content', () => {
    expect(requiredCapabilities('vision', textRequest)).toEqual(['vision']);
    expect(requiredCapabilities('skills', imageRequest)).toEqual(['vision']);
    expect(requiredCapabilities('skills', textRequest)).toEqual([]);
  });

  it('holds a model only to the routing operations it can serve', () => {
    expect(operationsServed('routing', ['vision'])).toEqual([
      ...ROUTING_OPERATIONS,
    ]);
    expect(operationsServed('routing', [])).not.toContain('vision');
    expect(operationsServed('routing', []).length).toBe(
      ROUTING_OPERATIONS.length - 1,
    );
    // Unknown capabilities (no status yet): every operation.
    expect(operationsServed('routing')).toEqual([...ROUTING_OPERATIONS]);
    expect(servesOperation('query', [])).toBe(true);
  });

  it('counts an image as a fixed estimate, not its base64 length', async () => {
    const text = await countRequestTokens(textRequest);
    const withImage = await countRequestTokens(imageRequest);
    expect(withImage).toBeLessThan(text + IMAGE_TOKENS_HIGH_DETAIL + 50);
    expect(withImage).toBeGreaterThanOrEqual(IMAGE_TOKENS_HIGH_DETAIL);
  });
});

/**
 * Capability checks for auxiliary candidates, from model metadata.
 *
 * A request needs a capability because its operation declares it
 * (OPERATION_CAPABILITIES) or because of what it carries (an image part
 * needs `vision`). The executor skips any candidate whose model metadata
 * lacks a needed capability, so a residency-verified chain model that
 * cannot read images is never sent one.
 */
import { IMAGE_TOKENS_HIGH_DETAIL } from '@/lib/utils/server/chat/chat';
import { countTokens } from '@/lib/utils/server/tiktoken/tiktokenCache';

import type { OpenAIModel } from '@/types/openai';

import {
  AUXILIARY_CAPABILITIES,
  type AuxiliaryCapability,
  type AuxiliaryOperation,
  OPERATION_CAPABILITIES,
} from './types';

import type OpenAI from 'openai';

type CompletionParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/** Whether model metadata declares one capability. */
function modelHas(
  model: OpenAIModel,
  capability: AuxiliaryCapability,
): boolean {
  switch (capability) {
    case 'vision':
      return model.supportsVision === true;
  }
}

/** Every capability a model's metadata declares. */
export function modelCapabilities(model: OpenAIModel): AuxiliaryCapability[] {
  return AUXILIARY_CAPABILITIES.filter((capability) =>
    modelHas(model, capability),
  );
}

/** Number of image parts in a request's messages. */
export function imagePartCount(params: CompletionParams): number {
  let count = 0;
  for (const message of params.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content)
      if ((part as { type?: string }).type === 'image_url') count++;
  }
  return count;
}

/**
 * What a request needs from the model serving it: its operation's declared
 * capabilities plus what its content implies.
 */
export function requiredCapabilities(
  operation: AuxiliaryOperation,
  params: CompletionParams,
): AuxiliaryCapability[] {
  const required = new Set(OPERATION_CAPABILITIES[operation] ?? []);
  if (imagePartCount(params) > 0) required.add('vision');
  return [...required];
}

/** The first required capability a model lacks, or undefined. */
export function missingCapability(
  model: OpenAIModel,
  required: readonly AuxiliaryCapability[],
): AuxiliaryCapability | undefined {
  return required.find((capability) => !modelHas(model, capability));
}

/**
 * Prompt-token estimate for an admission check. Image data is not text:
 * counting its base64 would put any page image over every context limit,
 * so each image counts as a fixed high-detail estimate instead.
 */
export async function countRequestTokens(
  params: CompletionParams,
): Promise<number> {
  const images = imagePartCount(params);
  if (images === 0) return countTokens(JSON.stringify(params));
  const textOnly: CompletionParams = {
    ...params,
    messages: params.messages.map((message) =>
      Array.isArray(message.content)
        ? ({
            ...message,
            content: message.content.filter(
              (part) => (part as { type?: string }).type !== 'image_url',
            ),
          } as typeof message)
        : message,
    ),
  };
  return (
    (await countTokens(JSON.stringify(textOnly))) +
    images * IMAGE_TOKENS_HIGH_DETAIL
  );
}

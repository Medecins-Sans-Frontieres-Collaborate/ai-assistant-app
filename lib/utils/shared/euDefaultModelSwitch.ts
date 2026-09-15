import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';
import { UserRegion } from '@/lib/utils/shared/region';

import { OpenAIModel, OpenAIModelID } from '@/types/openai';

/**
 * One-time default-model switch for EU users (2026-09-14, pricing).
 *
 * The catalog default already moved to gpt-5.4, but `defaultModelId` is
 * persisted per browser and the models query only re-selects a default
 * when the persisted one is no longer selectable — so everyone who ever
 * had gpt-5.2-chat as their default kept it. This planner decides, once per
 * browser (the persisted `applied` marker), whether to move that persisted
 * default. Temporary: remove with the hook one release after it ships.
 *
 * Deliberately narrow: only the exact old default is touched; a user who
 * picked any other model keeps it (the marker is set so they are never
 * asked again), and the switch waits (no marker) until the target model is
 * actually selectable in the EU so it can't land on a missing deployment.
 */
export const EU_DEFAULT_MODEL_SWITCH_FROM: string = OpenAIModelID.GPT_5_2_CHAT;
export const EU_DEFAULT_MODEL_SWITCH_TO: string = OpenAIModelID.GPT_5_4;

export interface EuDefaultModelSwitchInput {
  region: UserRegion | null | undefined;
  applied: boolean;
  defaultModelId: string | undefined;
  models: OpenAIModel[];
}

export type EuDefaultModelSwitchPlan =
  | { action: 'none' }
  /** Nothing to change; record that this browser has been evaluated. */
  | { action: 'mark' }
  | { action: 'switch'; model: OpenAIModel };

export function planEuDefaultModelSwitch(
  input: EuDefaultModelSwitchInput,
): EuDefaultModelSwitchPlan {
  if (input.applied || input.region !== 'EU') {
    return { action: 'none' };
  }
  if (input.defaultModelId !== EU_DEFAULT_MODEL_SWITCH_FROM) {
    // Either never set (the dynamic default already resolves to the new
    // model) or a deliberate choice of something else — leave it alone.
    return { action: 'mark' };
  }
  const target = input.models.find(
    (m) =>
      m.id === EU_DEFAULT_MODEL_SWITCH_TO &&
      !m.isDisabled &&
      isModelSelectableInRegion(m, input.region),
  );
  if (!target) return { action: 'none' };
  return { action: 'switch', model: target };
}

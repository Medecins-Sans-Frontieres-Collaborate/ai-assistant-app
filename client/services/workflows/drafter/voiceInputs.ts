'use client';

import {
  DraftSetState,
  GenerateToneInput,
  ToneRef,
  VoiceSet,
} from '@/types/drafter';

import { useSettingsStore } from '@/client/stores/settingsStore';

export interface VoiceInputs {
  tones: Record<string, GenerateToneInput>;
  toneGuideIds: Record<string, string>;
}

/**
 * The voice each spec is written in, as the routes take it: the user's own
 * tones inline (they live on this device), organisation tone guides by id
 * (resolved server-side under access rules). A tone that has since been
 * deleted simply yields no voice; the spec writes from its own guidance.
 */
export function voiceInputsFor(
  state: DraftSetState,
  specIds: string[],
): VoiceInputs {
  const userTones = useSettingsStore.getState().tones;
  const inputs: VoiceInputs = { tones: {}, toneGuideIds: {} };
  for (const specId of specIds) {
    const ref = state.versions[specId]?.toneRef;
    if (!ref) continue;
    if (ref.kind === 'guide') {
      inputs.toneGuideIds[specId] = ref.id;
      continue;
    }
    const tone = userTones.find((entry) => entry.id === ref.id);
    if (tone) {
      inputs.tones[specId] = {
        name: tone.name,
        voiceRules: tone.voiceRules,
        examples: tone.examples,
      };
    }
  }
  return inputs;
}

/** The voices currently chosen, as a set that can be saved and re-applied. */
export function currentVoices(state: DraftSetState): Record<string, ToneRef> {
  const bySpec: Record<string, ToneRef> = {};
  for (const specId of state.specIds) {
    const ref = state.versions[specId]?.toneRef;
    if (ref) bySpec[specId] = ref;
  }
  return bySpec;
}

export function sameVoices(
  a: Record<string, ToneRef>,
  b: VoiceSet['bySpec'],
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(
    (key) => a[key]?.kind === b[key]?.kind && a[key]?.id === b[key]?.id,
  );
}

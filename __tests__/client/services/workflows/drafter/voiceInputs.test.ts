import {
  currentVoices,
  sameVoices,
  voiceInputsFor,
} from '@/client/services/workflows/drafter/voiceInputs';

import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import { emptyVersion } from '@/lib/utils/shared/drafter/core/versions';

import { DraftSetState } from '@/types/drafter';
import { Tone } from '@/types/tone';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

const tone: Tone = {
  id: 't1',
  name: 'Warm',
  description: '',
  voiceRules: 'Short sentences.',
  examples: 'Like this.',
  createdAt: '2026-09-21T10:00:00.000Z',
  folderId: null,
};

function state(): DraftSetState {
  return {
    updatedAt: '',
    sources: [],
    brief: emptyBrief(),
    guideIds: [],
    specIds: ['linkedin', 'x', 'bluesky'],
    layout: { hidden: [], pinned: [] },
    nextId: 1,
    versions: {
      linkedin: {
        ...emptyVersion('linkedin'),
        toneRef: { kind: 'tone', id: 't1' },
      },
      x: { ...emptyVersion('x'), toneRef: { kind: 'guide', id: 'g1' } },
      bluesky: emptyVersion('bluesky'),
    },
  };
}

describe('voiceInputsFor', () => {
  beforeEach(() => {
    useSettingsStore.setState({ tones: [tone] });
  });

  it('sends the user’s tone inline and an organisation guide by id', () => {
    expect(voiceInputsFor(state(), ['linkedin', 'x', 'bluesky'])).toEqual({
      tones: {
        linkedin: {
          name: 'Warm',
          voiceRules: 'Short sentences.',
          examples: 'Like this.',
        },
      },
      toneGuideIds: { x: 'g1' },
    });
  });

  it('only covers the specs asked for', () => {
    expect(voiceInputsFor(state(), ['bluesky'])).toEqual({
      tones: {},
      toneGuideIds: {},
    });
  });

  it('yields no voice for a tone that has been deleted', () => {
    useSettingsStore.setState({ tones: [] });
    expect(voiceInputsFor(state(), ['linkedin']).tones).toEqual({});
  });
});

describe('voice sets', () => {
  it('captures the chosen voices and recognises the same set again', () => {
    const chosen = currentVoices(state());
    expect(chosen).toEqual({
      linkedin: { kind: 'tone', id: 't1' },
      x: { kind: 'guide', id: 'g1' },
    });
    expect(sameVoices(chosen, { ...chosen })).toBe(true);
    expect(sameVoices(chosen, { linkedin: { kind: 'tone', id: 't1' } })).toBe(
      false,
    );
    expect(
      sameVoices(chosen, { ...chosen, x: { kind: 'tone', id: 'g1' } }),
    ).toBe(false);
  });
});

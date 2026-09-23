import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  LEARNED_HEADING,
  appendVoiceRule,
  markTaught,
  teachableInstruction,
} from '@/lib/utils/shared/drafter/core/teaching';
import { emptyVersion } from '@/lib/utils/shared/drafter/core/versions';

import { DraftSetState, Version, VersionEdit } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

function edit(instruction: string, status: VersionEdit['status']): VersionEdit {
  return {
    id: `${instruction}-${status}`,
    segmentId: 's1',
    criterion: 'revision',
    before: 'a',
    after: 'b',
    reason: '',
    severity: 'minor',
    status,
    instruction,
  };
}

function state(versions: Record<string, Version>): DraftSetState {
  return {
    updatedAt: '',
    sources: [],
    brief: emptyBrief(),
    guideIds: [],
    specIds: Object.keys(versions),
    layout: { hidden: [], pinned: [] },
    nextId: 1,
    versions,
  };
}

const voiced = (specId: string, edits: VersionEdit[]): Version => ({
  ...emptyVersion(specId),
  toneRef: { kind: 'tone', id: 't1' },
  edits,
});

describe('appendVoiceRule', () => {
  it('adds the user’s own words under one heading', () => {
    const once = appendVoiceRule('- Be warm.', 'Shorter  sentences');
    expect(once).toBe(`- Be warm.\n\n${LEARNED_HEADING}:\n- Shorter sentences`);
    const twice = appendVoiceRule(once, 'No exclamation marks');
    expect(twice.match(new RegExp(LEARNED_HEADING, 'gu'))).toHaveLength(1);
    expect(twice.endsWith('- No exclamation marks')).toBe(true);
  });

  it('does nothing for a rule already there, or an empty one', () => {
    const rules = appendVoiceRule('', 'Less jargon');
    expect(appendVoiceRule(rules, '  less   JARGON ')).toBe(rules);
    expect(appendVoiceRule(rules, '   ')).toBe(rules);
  });
});

describe('teachableInstruction', () => {
  it('offers an instruction accepted on one voiced channel only', () => {
    const s = state({
      linkedin: voiced('linkedin', [edit('less stiff', 'accepted')]),
      x: voiced('x', []),
    });
    expect(teachableInstruction(s, 'linkedin')).toBe('less stiff');
    expect(teachableInstruction(s, 'x')).toBeNull();
  });

  it('offers nothing for an instruction that went to several channels', () => {
    const s = state({
      linkedin: voiced('linkedin', [edit('less jargon', 'accepted')]),
      x: voiced('x', [edit('less jargon', 'accepted')]),
    });
    expect(teachableInstruction(s, 'linkedin')).toBeNull();
  });

  it('needs an accepted suggestion and a voice to add it to', () => {
    expect(
      teachableInstruction(
        state({ x: voiced('x', [edit('less stiff', 'rejected')]) }),
        'x',
      ),
    ).toBeNull();
    expect(
      teachableInstruction(
        state({
          x: { ...emptyVersion('x'), edits: [edit('less stiff', 'accepted')] },
        }),
        'x',
      ),
    ).toBeNull();
  });

  it('is offered once, whether it was added or declined', () => {
    const version = voiced('x', [edit('less stiff', 'accepted')]);
    const after = markTaught(version, 'less stiff');
    expect(teachableInstruction(state({ x: after }), 'x')).toBeNull();
    expect(markTaught(after, 'less stiff')).toBe(after);
  });

  it('ignores assessment suggestions, which carry no instruction', () => {
    const version = voiced('x', [edit('', 'accepted')]);
    expect(teachableInstruction(state({ x: version }), 'x')).toBeNull();
  });
});

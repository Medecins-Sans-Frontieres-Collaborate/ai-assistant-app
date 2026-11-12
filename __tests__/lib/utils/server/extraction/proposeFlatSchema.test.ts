/**
 * Schema proposal: runs as the `schemaProposal` helper operation in the
 * caller's region, retries once when no metric column was proposed, and
 * falls back to the chat model when the chain cannot answer.
 */
import {
  installFakeAuxiliaryCompletions,
  jsonReply,
} from '../../../services/auxiliary/fakeCompletions';

import { proposeFlatSchema } from '@/lib/utils/server/extraction/proposeFlatSchema';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const textOnly = {
  fields: [
    { name: 'project', type: 'text', description: 'Project', required: true },
  ],
};
const withMetric = {
  fields: [
    { name: 'project', type: 'text', description: 'Project', required: true },
    {
      name: 'budget_usd',
      type: 'number',
      description: 'Budget',
      required: false,
    },
  ],
};

let fake: ReturnType<typeof installFakeAuxiliaryCompletions>;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fake = installFakeAuxiliaryCompletions();
});
afterEach(() => {
  fake.restore();
  vi.restoreAllMocks();
});

describe('proposeFlatSchema', () => {
  it('proposes on the chain in the caller region with no hardcoded model', async () => {
    fake.create.mockResolvedValue(jsonReply(withMetric));
    const fields = await proposeFlatSchema(['Projects and budgets'], {
      region: 'US',
    });
    expect(fields.map((field) => field.name)).toEqual([
      'project',
      'budget_usd',
    ]);
    expect(fake.regions).toEqual(['US']);
    const sent = fake.create.mock.calls[0][0];
    expect(sent.model).toBe('');
    expect(sent.response_format.json_schema.name).toBe('flat_schema_proposal');
  });

  it('retries once with a nudge when no metric column was proposed', async () => {
    fake.create
      .mockResolvedValueOnce(jsonReply(textOnly))
      .mockResolvedValueOnce(jsonReply(withMetric));
    const fields = await proposeFlatSchema(['Projects'], { region: 'EU' });
    expect(fake.create).toHaveBeenCalledTimes(2);
    expect(fake.create.mock.calls[1][0].messages[1].content).toContain(
      'Your previous response had no number, date, or enum field',
    );
    expect(fields.some((field) => field.type === 'number')).toBe(true);
  });

  it("falls back to the caller's chat model when the chain fails", async () => {
    fake.create.mockRejectedValue(new Error('no eligible model'));
    const fallback = vi.fn(async () => ({
      text: JSON.stringify(withMetric),
      model: { id: 'mistral-large' } as never,
      region: 'EU' as const,
    }));
    const fields = await proposeFlatSchema(['Projects'], {
      region: 'EU',
      fallback,
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fields).toHaveLength(2);
  });

  it('throws when no path produced a proposal', async () => {
    fake.create.mockResolvedValue(jsonReply({ nothing: true }));
    await expect(
      proposeFlatSchema(['Projects'], { region: 'EU' }),
    ).rejects.toBeDefined();
  });
});

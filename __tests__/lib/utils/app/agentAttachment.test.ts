import {
  AvailableAgent,
  agentModelSemantics,
  attachAgentUpdates,
  detachAgentUpdates,
  isAgentShapedModelId,
  isDecoupledAgentAttachment,
} from '@/lib/utils/app/agentAttachment';

import { OpenAIModel } from '@/types/openai';

import { describe, expect, it } from 'vitest';

const realModel = { id: 'gpt-5.2', name: 'GPT-5.2' } as OpenAIModel;
const otherModel = { id: 'gpt-4.1', name: 'GPT-4.1' } as OpenAIModel;
const foundryModel = {
  id: 'foundry-abc123-agent1',
  name: 'Field Ops Assistant',
  agentId: 'field-ops',
} as OpenAIModel;

const knowledgeAgent: AvailableAgent = {
  id: 'orgr-abc',
  botId: 'orgr-abc',
  name: 'Org Knowledge',
  kind: 'org',
};

const foundryAgent: AvailableAgent = {
  id: 'foundry-agent1',
  name: 'Field Ops Assistant',
  kind: 'foundry',
  foundryModel,
};

describe('isAgentShapedModelId / isDecoupledAgentAttachment', () => {
  it('classifies org-/foundry-/custom- ids as agent-shaped', () => {
    expect(isAgentShapedModelId('org-msf_communications')).toBe(true);
    expect(isAgentShapedModelId('foundry-x-y')).toBe(true);
    expect(isAgentShapedModelId('custom-abc')).toBe(true);
    expect(isAgentShapedModelId('gpt-5.2')).toBe(false);
    expect(isAgentShapedModelId(undefined)).toBe(false);
  });

  it('a bot beside a real model is decoupled; beside its org- mirror it is legacy', () => {
    expect(
      isDecoupledAgentAttachment({ bot: 'orgr-abc', model: realModel }),
    ).toBe(true);
    expect(
      isDecoupledAgentAttachment({
        bot: 'msf_communications',
        model: { id: 'org-msf_communications' } as OpenAIModel,
      }),
    ).toBe(false);
    expect(
      isDecoupledAgentAttachment({ bot: undefined, model: realModel }),
    ).toBe(false);
  });
});

describe('attachAgentUpdates', () => {
  it('knowledge agents attach bot-only, leaving the model alone', () => {
    const updates = attachAgentUpdates(
      { bot: undefined, model: realModel, threadId: undefined },
      knowledgeAgent,
    );
    expect(updates).toEqual({ bot: 'orgr-abc' });
  });

  it('foundry agents swap the model and remember the real one', () => {
    const updates = attachAgentUpdates(
      { bot: undefined, model: realModel, threadId: 'thread-1' },
      foundryAgent,
    );
    expect(updates.model).toBe(foundryModel);
    expect(updates.agentPrevModelId).toBe('gpt-5.2');
    expect(updates.threadId).toBeUndefined();
  });

  it('foundry→foundry hop keeps the earlier remembered real model', () => {
    const updates = attachAgentUpdates(
      {
        bot: undefined,
        model: { id: 'foundry-old-agent' } as OpenAIModel,
        threadId: undefined,
        agentPrevModelId: 'gpt-4.1',
      },
      foundryAgent,
    );
    expect(updates.agentPrevModelId).toBe('gpt-4.1');
  });
});

describe('detachAgentUpdates', () => {
  it('knowledge detach clears bot and keeps the model', () => {
    const updates = detachAgentUpdates(
      { bot: 'orgr-abc', model: realModel, agentPrevModelId: undefined },
      [realModel, otherModel],
      otherModel,
    );
    expect(updates.bot).toBeUndefined();
    expect(updates.model).toBeUndefined();
  });

  it('foundry detach restores the remembered model when it still exists', () => {
    const updates = detachAgentUpdates(
      { bot: undefined, model: foundryModel, agentPrevModelId: 'gpt-5.2' },
      [realModel, otherModel],
      otherModel,
    );
    expect(updates.model).toBe(realModel);
    expect(updates.threadId).toBeUndefined();
    expect(updates.agentPrevModelId).toBeUndefined();
  });

  it('foundry detach falls back to the default model when the memory is gone', () => {
    const updates = detachAgentUpdates(
      {
        bot: undefined,
        model: foundryModel,
        agentPrevModelId: 'retired-model',
      },
      [otherModel],
      otherModel,
    );
    expect(updates.model).toBe(otherModel);
  });
});

describe('agentModelSemantics', () => {
  it('maps kinds to their model relationship', () => {
    expect(agentModelSemantics('rag')).toBe('your-model');
    expect(agentModelSemantics('org')).toBe('your-model');
    expect(agentModelSemantics('m365')).toBe('your-model');
    expect(agentModelSemantics('prompt')).toBe('pinned-model');
    expect(agentModelSemantics('foundry')).toBe('own-model');
  });
});

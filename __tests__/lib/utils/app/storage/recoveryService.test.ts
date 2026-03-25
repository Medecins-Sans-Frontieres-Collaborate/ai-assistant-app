import { attemptRecovery } from '@/lib/utils/app/storage/recoveryService';

import { describe, expect, it } from 'vitest';

describe('recoveryService', () => {
  const validConvJSON = JSON.stringify({
    id: 'conv-1',
    name: 'Test',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ],
    model: { id: 'gpt-4', name: 'GPT-4' },
    temperature: 0.7,
    prompt: '',
    folderId: null,
  });

  it('recovers a valid conversation with no changes', () => {
    const result = attemptRecovery(validConvJSON);
    expect(result.recovered).toBe(true);
    expect(result.conversation).toBeDefined();
    expect(result.stats.messagesRecovered).toBe(2);
    expect(result.stats.messagesLost).toBe(0);
  });

  it('recovers conversation with missing optional fields', () => {
    const data = JSON.stringify({
      id: 'conv-2',
      name: 'Partial',
      messages: [],
      model: { id: 'gpt-4', name: 'GPT-4' },
      temperature: 0.5,
      prompt: 'test',
      folderId: null,
    });
    const result = attemptRecovery(data);
    expect(result.recovered).toBe(true);
  });

  it('repairs missing required fields with defaults', () => {
    const data = JSON.stringify({
      id: 'conv-3',
      // missing: name, model, temperature, prompt
      messages: [],
    });

    const result = attemptRecovery(data);
    expect(result.recovered).toBe(true);
    expect(result.conversation!.name).toBe('Recovered Conversation');
    expect(result.conversation!.model).toBeDefined();
    expect(typeof result.conversation!.temperature).toBe('number');
    expect(typeof result.conversation!.prompt).toBe('string');
    expect(result.stats.fieldsRepaired).toContain('name');
    expect(result.stats.fieldsRepaired).toContain('model');
    expect(result.stats.fieldsRepaired).toContain('temperature');
    expect(result.stats.fieldsRepaired).toContain('prompt');
  });

  it('generates id if missing', () => {
    const data = JSON.stringify({
      name: 'No ID',
      messages: [],
      model: { id: 'gpt-4', name: 'GPT-4' },
      temperature: 0.7,
      prompt: '',
      folderId: null,
    });

    const result = attemptRecovery(data);
    expect(result.recovered).toBe(true);
    expect(result.conversation!.id).toBeDefined();
    expect(result.stats.fieldsRepaired).toContain('id');
  });

  it('salvages valid messages and discards corrupt ones', () => {
    const data = JSON.stringify({
      id: 'conv-4',
      name: 'Mixed Messages',
      messages: [
        { role: 'user', content: 'Hello' },
        null,
        'not a message',
        { role: 'assistant', content: 'Response' },
        { broken: true },
      ],
      model: { id: 'gpt-4', name: 'GPT-4' },
      temperature: 0.7,
      prompt: '',
      folderId: null,
    });

    const result = attemptRecovery(data);
    expect(result.recovered).toBe(true);
    expect(result.stats.messagesRecovered).toBe(2);
    expect(result.stats.messagesLost).toBe(3);
  });

  it('handles JSON with trailing commas', () => {
    const brokenJSON =
      '{"id": "conv-5", "name": "Trailing",  "messages": [], "model": {"id": "gpt-4", "name": "GPT-4"}, "temperature": 0.7, "prompt": "", "folderId": null,}';

    const result = attemptRecovery(brokenJSON);
    expect(result.recovered).toBe(true);
    expect(result.stats.fieldsRepaired).toContain('json_structure');
  });

  it('handles truncated JSON', () => {
    const truncated =
      '{"id": "conv-6", "name": "Truncated", "messages": [{"role": "user", "content": "Hi"';

    const result = attemptRecovery(truncated);
    // May or may not recover depending on repair heuristics
    // but should not throw
    expect(typeof result.recovered).toBe('boolean');
  });

  it('returns false for completely unrecoverable data', () => {
    const result = attemptRecovery('this is not json at all <<<>>>');
    expect(result.recovered).toBe(false);
    expect(result.stats.messagesRecovered).toBe(0);
  });

  it('preserves assistant message groups', () => {
    const data = JSON.stringify({
      id: 'conv-7',
      name: 'With Groups',
      messages: [
        { role: 'user', content: 'Hello' },
        {
          type: 'assistant_group',
          activeIndex: 0,
          versions: [
            {
              content: 'First response',
              messageType: 'TEXT',
              createdAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      ],
      model: { id: 'gpt-4', name: 'GPT-4' },
      temperature: 0.7,
      prompt: '',
      folderId: null,
    });

    const result = attemptRecovery(data);
    expect(result.recovered).toBe(true);
    expect(result.stats.messagesRecovered).toBe(2);
    expect(result.stats.messagesLost).toBe(0);
  });

  it('prefixes name with [Recovered] when fields are repaired', () => {
    const data = JSON.stringify({
      id: 'conv-8',
      name: 'My Chat',
      messages: [],
      // missing model, temperature, prompt
    });

    const result = attemptRecovery(data);
    expect(result.recovered).toBe(true);
    expect(result.conversation!.name).toBe('[Recovered] My Chat');
  });
});

import { Conversation } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { chatService } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W5: a discovered model (present only in settings.models, not in the static
 * OpenAIModels map) must be re-validated against the ring gate in
 * sendChatRequest before it's accepted. A discovered model flagged
 * `isDisabled` (or ring-gated off) is treated as not-found and the request
 * falls through to the fallback-model path.
 */
describe('ChatStore - discovered model ring gate (W5)', () => {
  const initialState = useChatStore.getState();
  const settingsInitial = useSettingsStore.getState();

  const makeDiscoveredModel = (
    overrides: Partial<OpenAIModel> = {},
  ): OpenAIModel => ({
    id: 'discovered-x',
    name: 'Discovered X',
    maxLength: 8192,
    tokenLimit: 4096,
    ...overrides,
  });

  const makeConversation = (model: OpenAIModel): Conversation =>
    ({
      id: 'conv-1',
      name: 'Test conversation',
      messages: [{ role: 'user', content: 'hello' }],
      model,
      prompt: '',
      temperature: 1,
      folderId: null,
    }) as unknown as Conversation;

  beforeEach(() => {
    vi.restoreAllMocks();
    useChatStore.setState(initialState, true);
    useSettingsStore.setState(settingsInitial, true);
    // A valid persisted default so the fallback path can rescue a request.
    useSettingsStore.getState().setDefaultModelId(OpenAIModelID.GPT_5_2_CHAT);
  });

  it('falls through to the fallback model when the discovered model is disabled', async () => {
    const disabled = makeDiscoveredModel({ isDisabled: true });
    useSettingsStore.getState().setModels([disabled]);

    const chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream<Uint8Array>());

    await useChatStore.getState().sendChatRequest(makeConversation(disabled));

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const sentModel = chatSpy.mock.calls[0][0] as OpenAIModel;
    // Not the disabled discovered model — rescued to the persisted default.
    expect(sentModel.id).not.toBe('discovered-x');
    expect(sentModel.id).toBe(OpenAIModelID.GPT_5_2_CHAT);
  });

  it('uses the discovered model when it is enabled', async () => {
    const enabled = makeDiscoveredModel({ isDisabled: false });
    useSettingsStore.getState().setModels([enabled]);

    const chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream<Uint8Array>());

    await useChatStore.getState().sendChatRequest(makeConversation(enabled));

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const sentModel = chatSpy.mock.calls[0][0] as OpenAIModel;
    expect(sentModel.id).toBe('discovered-x');
  });

  it('US user + EU-only model: SENDS the model with implicit hostedRegion EU', async () => {
    const euOnly = makeDiscoveredModel({ hostedIn: ['EU'] });
    useSettingsStore.getState().setModels([euOnly]);
    useSettingsStore.getState().setUserRegion('US');

    const chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream<Uint8Array>());

    await useChatStore.getState().sendChatRequest(makeConversation(euOnly));

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const sentModel = chatSpy.mock.calls[0][0] as OpenAIModel;
    // Cross-region routing: the model is usable, chat targets its region.
    expect(sentModel.id).toBe('discovered-x');
    const options = chatSpy.mock.calls[0][2] as { hostedRegion?: string };
    expect(options.hostedRegion).toBe('EU');
  });

  it('EU user + US-only model: falls back (residency gate)', async () => {
    const usOnly = makeDiscoveredModel({ hostedIn: ['US'] });
    useSettingsStore.getState().setModels([usOnly]);
    useSettingsStore.getState().setUserRegion('EU');

    const chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream<Uint8Array>());

    await useChatStore.getState().sendChatRequest(makeConversation(usOnly));

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const sentModel = chatSpy.mock.calls[0][0] as OpenAIModel;
    expect(sentModel.id).toBe(OpenAIModelID.GPT_5_2_CHAT);
  });

  it('uses a discovered model hosted in the user region', async () => {
    const dualRegion = makeDiscoveredModel({ hostedIn: ['US', 'EU'] });
    useSettingsStore.getState().setModels([dualRegion]);
    useSettingsStore.getState().setUserRegion('US');

    const chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream<Uint8Array>());

    await useChatStore.getState().sendChatRequest(makeConversation(dualRegion));

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const sentModel = chatSpy.mock.calls[0][0] as OpenAIModel;
    expect(sentModel.id).toBe('discovered-x');
  });

  it('stays permissive while the session region is unknown', async () => {
    const euOnly = makeDiscoveredModel({ hostedIn: ['EU'] });
    useSettingsStore.getState().setModels([euOnly]);
    useSettingsStore.getState().setUserRegion(null);

    const chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream<Uint8Array>());

    await useChatStore.getState().sendChatRequest(makeConversation(euOnly));

    const sentModel = chatSpy.mock.calls[0][0] as OpenAIModel;
    expect(sentModel.id).toBe('discovered-x');
  });

  it('still uses static models present in OpenAIModels directly', async () => {
    const staticModel = OpenAIModels[OpenAIModelID.GPT_5_2];
    useSettingsStore.getState().setModels([]);

    const chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream<Uint8Array>());

    await useChatStore
      .getState()
      .sendChatRequest(makeConversation(staticModel));

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const sentModel = chatSpy.mock.calls[0][0] as OpenAIModel;
    expect(sentModel.id).toBe(OpenAIModelID.GPT_5_2);
  });
});

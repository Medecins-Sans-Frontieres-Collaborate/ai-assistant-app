import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';
import { ModelListSource, OpenAIModelID } from '@/types/openai';

import { ModelUnavailableNotice } from '@/components/Chat/ModelUnavailableNotice';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Translate from the REAL messages/en.json so a missing `limitsUx.*` key
// fails here instead of rendering as a raw key in the app. (The global
// next-intl mock in vitest.setup.dom.ts has its own hand-maintained map.)
const enMessages = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'messages/en.json'), 'utf8'),
  ) as Record<string, unknown>;
});
vi.mock('next-intl', () => ({
  useTranslations: () => {
    const translate = (key: string, params?: Record<string, unknown>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (acc, part) =>
            acc && typeof acc === 'object'
              ? (acc as Record<string, unknown>)[part]
              : undefined,
          enMessages,
        );
      if (typeof value !== 'string') {
        throw new Error(`Missing en.json key: ${key}`);
      }
      return Object.entries(params ?? {}).reduce(
        (str, [k, v]) => str.replaceAll(`{${k}}`, String(v)),
        value,
      );
    };
    translate.has = () => true;
    translate.rich = translate;
    return translate;
  },
  useLocale: () => 'en',
}));

const availabilityById = vi.hoisted(
  () => new Map<string, { state: string; reason?: string; resetAt?: string }>(),
);
const useResetCountdown = vi.hoisted(() =>
  vi.fn((resetAt?: string) => (resetAt ? 'in 2 hours' : null)),
);
vi.mock('@/client/hooks/settings/useMyLimits', () => ({
  useModelAvailability: (id?: string) =>
    (id && availabilityById.get(id)) ?? { state: 'available' },
  useResetCountdown,
}));

const SERVED = [
  { id: 'gpt-5.2-chat', name: 'GPT-5.2 Chat' },
  { id: 'discovered-only', name: 'Discovered' },
] as any[];

function conversationWith(model: Record<string, unknown>): Conversation {
  return {
    id: 'conv-1',
    name: '',
    messages: [],
    model,
    prompt: '',
    temperature: 0.5,
    folderId: null,
  } as unknown as Conversation;
}

function renderNotice(
  model: Record<string, unknown>,
  source: ModelListSource | null = 'discovery',
) {
  useSettingsStore.setState({ models: SERVED, modelListSource: source });
  const onChooseModel = vi.fn();
  const view = render(
    <ModelUnavailableNotice
      conversation={conversationWith(model)}
      onChooseModel={onChooseModel}
    />,
  );
  return { onChooseModel, ...view };
}

/**
 * docs/LIMITS_USER_FACING_UX.md §3b/§7.4: when the selected conversation's
 * model was hidden out from under it, or is out of budget, say so above the
 * composer and offer the picker — never swap silently.
 */
describe('ModelUnavailableNotice', () => {
  beforeEach(() => {
    availabilityById.clear();
    vi.clearAllMocks();
  });

  it('renders nothing for a served, available model', () => {
    const { container } = renderNotice({
      id: 'gpt-5.2-chat',
      name: 'GPT-5.2 Chat',
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('flags a model the server no longer serves and opens the picker', () => {
    const { onChooseModel } = renderNotice({ id: 'o3', name: 'o3' });

    expect(screen.getByRole('status')).toHaveTextContent(
      "o3 isn't available on your account",
    );
    fireEvent.click(screen.getByText('Choose model'));
    expect(onChooseModel).toHaveBeenCalledOnce();
  });

  it('waits for discovery before judging a discovered-only model', () => {
    // Static seed still in place: the discovered model is legitimately
    // missing from it, so nothing must flash.
    const { container } = renderNotice(
      { id: 'discovered-elsewhere', name: 'Discovered' },
      'static',
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does flag a static-catalog model missing from even the static seed', () => {
    useSettingsStore.setState({ models: [], modelListSource: 'static' });
    render(
      <ModelUnavailableNotice
        conversation={conversationWith({
          id: OpenAIModelID.GPT_5_2_CHAT,
          name: 'GPT-5.2 Chat',
        })}
        onChooseModel={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('flags a blocked model with the unavailable copy', () => {
    availabilityById.set('gpt-5.2-chat', {
      state: 'blocked',
      reason: 'blocked',
    });
    renderNotice({ id: 'gpt-5.2-chat', name: 'GPT-5.2 Chat' });

    expect(screen.getByRole('status')).toHaveTextContent(
      "GPT-5.2 Chat isn't available on your account",
    );
  });

  it('flags an exhausted model with a relative reset', () => {
    availabilityById.set('gpt-5.2-chat', {
      state: 'exhausted',
      reason: 'exhausted',
      resetAt: '2026-09-09T00:00:00.000Z',
    });
    renderNotice({ id: 'gpt-5.2-chat', name: 'GPT-5.2 Chat' });

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('GPT-5.2 Chat has reached its limit');
    expect(status).toHaveTextContent('Resets in 2 hours.');
    expect(useResetCountdown).toHaveBeenCalledWith('2026-09-09T00:00:00.000Z');
  });

  it('uses the family copy when the shared envelope is used up', () => {
    availabilityById.set('gpt-5.2-chat', {
      state: 'exhausted',
      reason: 'familyExhausted',
    });
    renderNotice({ id: 'gpt-5.2-chat', name: 'GPT-5.2 Chat' });

    expect(screen.getByRole('status')).toHaveTextContent(/model family/);
  });

  it('ignores agents, byom and local models (never in the served list)', () => {
    for (const model of [
      { id: 'custom-abc', name: 'My Agent' },
      { id: 'org-comms', name: 'Comms', isOrganizationAgent: true },
      { id: 'foundry-x', name: 'Foundry' },
      { id: 'byom-acct-gpt', name: 'Own GPT', isCustomSourceModel: true },
      { id: 'local-ollama-llama3', name: 'llama3', isLocalModel: true },
    ]) {
      const { container, unmount } = renderNotice(model);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('renders nothing without a conversation', () => {
    const { container } = render(
      <ModelUnavailableNotice conversation={null} onChooseModel={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

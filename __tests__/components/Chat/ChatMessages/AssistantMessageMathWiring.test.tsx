import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { AssistantMessage } from '@/components/Chat/ChatMessages/AssistantMessage';

import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { citationStreamdownProps } = vi.hoisted(() => ({
  citationStreamdownProps: [] as Record<string, unknown>[],
}));

// Capture what AssistantMessage hands the renderer. `next/dynamic` is bypassed
// so the stub renders synchronously — the assertions are about props, not
// about the lazy-loading boundary.
vi.mock('next/dynamic', () => ({
  default: () => {
    const Stub = (props: Record<string, unknown>) => {
      citationStreamdownProps.push(props);
      return <div data-testid="markdown">{String(props.children ?? '')}</div>;
    };
    return Stub;
  },
}));

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({
    ttsSettings: {
      rate: 1,
      pitch: 1,
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      globalVoice: '',
      languageVoices: {},
    },
  }),
}));

vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({ enabled: false, sharingEnabled: false }),
}));

vi.mock('@/lib/services/translation', () => ({ translateText: vi.fn() }));

// The exact shape issue #121 reports: a model that never saw the KaTeX rules
// (an agent whose prompt replaced the base prompt) emits \[ ... \].
const RAW = 'Area \\[ \\pi r^2 \\] grows.';

function renderMessage(messageIsStreaming: boolean) {
  return render(
    <AssistantMessage
      content={RAW}
      messageIsStreaming={messageIsStreaming}
      messageIndex={0}
      selectedConversation={null}
    />,
  );
}

describe('AssistantMessage — math render wiring', () => {
  beforeEach(() => {
    citationStreamdownProps.length = 0;
  });

  it('renders a FINISHED message in static mode', async () => {
    renderMessage(false);

    await waitFor(() =>
      expect(citationStreamdownProps.length).toBeGreaterThan(0),
    );
    const last = citationStreamdownProps.at(-1)!;
    // "static" is the only mode that skips Streamdown's block splitting and
    // its incomplete-markdown completion; a finished message can never gain
    // more text, so paying for either is waste and actively breaks display
    // math that spans a blank line.
    expect(last.mode).toBe('static');
  });

  it('renders a STREAMING message in streaming mode', async () => {
    renderMessage(true);

    await waitFor(() =>
      expect(citationStreamdownProps.length).toBeGreaterThan(0),
    );
    expect(citationStreamdownProps.at(-1)!.mode).toBe('streaming');
  });

  it('hands the renderer the message content unchanged (normalization is the renderer’s job)', async () => {
    renderMessage(false);

    await waitFor(() =>
      expect(citationStreamdownProps.length).toBeGreaterThan(0),
    );
    // The transform lives inside CitationStreamdown so that STORED content
    // stays pristine — nothing upstream rewrites the model's text.
    expect(citationStreamdownProps.at(-1)!.children).toBe(RAW);
  });

  it('copies the ORIGINAL, un-normalized markdown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    renderMessage(false);
    await waitFor(() =>
      expect(citationStreamdownProps.length).toBeGreaterThan(0),
    );

    // next-intl is mocked globally and echoes unknown keys, so match either
    // the key or a real translation.
    const copyButton = await screen.findByLabelText(
      /copyMessage|copy message/i,
    );
    await userEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RAW));
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Conversation } from '@/types/chat';

import { M365PlaybookChips } from '@/components/Chat/ChatInput/M365PlaybookChips';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let selectedConversation: Partial<Conversation> | null;

vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({
    selectedConversation,
    updateConversation: vi.fn(),
  }),
}));

let playbooksEnabled = true;
vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({
    filesEnabled: true,
    mailEnabled: true,
    agentsEnabled: true,
    translationEnabled: true,
    transcriptionEnabled: true,
    docSyncEnabled: true,
    meetingsEnabled: true,
    toolsEnabled: true,
    playbooksEnabled,
  }),
}));

function conversationWithTranscript(): Partial<Conversation> {
  return {
    id: 'conv-1',
    messages: [
      { role: 'user', content: 'imported the meeting', messageType: 'TEXT' },
      {
        role: 'assistant',
        content: '[Transcript: Weekly sync.docx]\nAna: hello',
        messageType: 'TEXT',
      },
    ] as Conversation['messages'],
  };
}

describe('M365PlaybookChips', () => {
  beforeEach(() => {
    playbooksEnabled = true;
    selectedConversation = conversationWithTranscript();
    // Afternoon, so only the transcript-anchored playbook is eligible unless
    // a test moves the clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 31, 15, 0, 0));
    useSettingsStore.setState({
      m365Connected: true,
      m365PlaybookChipsEnabled: true,
    });
    useChatInputStore.setState({ textFieldValue: '', filePreviews: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suggests meeting follow-through when the conversation holds a transcript', () => {
    render(<M365PlaybookChips />);

    expect(
      screen.getByText('Playbook: Meeting follow-through'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Playbook: Morning triage')).toBeNull();
  });

  it('suggests morning triage inside the morning band', () => {
    vi.setSystemTime(new Date(2026, 6, 31, 8, 0, 0));
    render(<M365PlaybookChips />);

    expect(screen.getByText('Playbook: Morning triage')).toBeInTheDocument();
  });

  it('renders nothing when no precondition holds', () => {
    selectedConversation = { id: 'conv-1', messages: [] };
    const { container } = render(<M365PlaybookChips />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while Microsoft 365 is not connected', () => {
    useSettingsStore.setState({ m365Connected: false });
    const { container } = render(<M365PlaybookChips />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the user turned chips off', () => {
    useSettingsStore.setState({ m365PlaybookChipsEnabled: false });
    const { container } = render(<M365PlaybookChips />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the LaunchDarkly gate is off', () => {
    playbooksEnabled = false;
    const { container } = render(<M365PlaybookChips />);

    expect(container).toBeEmptyDOMElement();
  });

  it('fills the composer with the prompt instead of sending it', async () => {
    render(<M365PlaybookChips />);

    fireEvent.click(screen.getByText('Playbook: Meeting follow-through'));

    await waitFor(() => {
      expect(useChatInputStore.getState().textFieldValue).toContain('STAGE 1');
    });
    const filled = useChatInputStore.getState().textFieldValue;
    expect(filled).toContain('STAGE 2');
    expect(filled).toContain('drafted from:');
  });

  it('appends below text the user already typed rather than discarding it', async () => {
    useChatInputStore.setState({ textFieldValue: 'keep me' });
    render(<M365PlaybookChips />);

    fireEvent.click(screen.getByText('Playbook: Meeting follow-through'));

    await waitFor(() => {
      expect(useChatInputStore.getState().textFieldValue).toContain('STAGE 1');
    });
    expect(useChatInputStore.getState().textFieldValue).toMatch(/^keep me\n\n/);
  });

  it('dismissing hides that chip for the session only', () => {
    vi.setSystemTime(new Date(2026, 6, 31, 8, 0, 0));
    render(<M365PlaybookChips />);

    fireEvent.click(screen.getByLabelText('Dismiss Meeting follow-through'));

    expect(screen.queryByText('Playbook: Meeting follow-through')).toBeNull();
    // Sibling chips survive, and nothing was persisted.
    expect(screen.getByText('Playbook: Morning triage')).toBeInTheDocument();
    expect(useSettingsStore.getState().m365PlaybookChipsEnabled).toBe(true);
  });

  it('suggests follow-through for a transcript-ish upload in the composer', () => {
    selectedConversation = { id: 'conv-1', messages: [] };
    useChatInputStore.setState({
      filePreviews: [
        {
          name: 'weekly-sync.vtt',
          type: 'text/vtt',
          status: 'completed',
          previewUrl: 'blob:x',
        },
      ] as ReturnType<typeof useChatInputStore.getState>['filePreviews'],
    });
    render(<M365PlaybookChips />);

    expect(
      screen.getByText('Playbook: Meeting follow-through'),
    ).toBeInTheDocument();
  });
});

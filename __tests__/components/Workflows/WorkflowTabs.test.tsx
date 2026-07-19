import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';
import { TranslationWorkflowState } from '@/types/workflow';

import { WorkflowTabs } from '@/components/Workflows/WorkflowTabs';

import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockFlags: Record<string, unknown> = {};

vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const emptyConversation = {
  id: 'conv-1',
  name: '',
  messages: [],
  model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
  prompt: '',
  temperature: 0.5,
  folderId: null,
} as Conversation;

const translationState = (
  overrides: Partial<TranslationWorkflowState> = {},
): TranslationWorkflowState => ({
  kind: 'translation',
  sourceText: '',
  mode: 'agentic',
  rounds: [],
  updatedAt: '2026-07-09T00:00:00.000Z',
  ...overrides,
});

function setStore(conversation: Conversation | null) {
  useConversationStore.setState({
    conversations: conversation ? [conversation] : [],
    selectedConversationId: conversation?.id ?? null,
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

const originalLocation = window.location;

/**
 * The flag gate is bypassed on localhost, which is also jsdom's default
 * host — so the fail-closed cases must run against a real-looking host or
 * they'd pass for the wrong reason.
 */
function setHostname(hostname: string) {
  Object.defineProperty(window, 'location', {
    value: { ...originalLocation, hostname },
    writable: true,
    configurable: true,
  });
}

/** Mock translations echo the key, so the Chat tab's name is `tabs.chat`. */
const CHAT = 'tabs.chat';
const TRANSLATION = 'types.translation.label';
const MAP = 'types.map.label';

const stored = () => useConversationStore.getState().conversations[0];

describe('WorkflowTabs', () => {
  beforeEach(() => {
    mockFlags = {};
    setHostname('assistant.example.org');
    setStore(emptyConversation);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  describe('visibility', () => {
    it('renders nothing when the flag is undefined (fail-closed)', () => {
      const { container } = render(<WorkflowTabs />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when the flag is false', () => {
      mockFlags = { conversationWorkflows: false };
      const { container } = render(<WorkflowTabs />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders on localhost even without the flag', () => {
      setHostname('localhost');
      render(<WorkflowTabs />);
      expect(screen.getAllByRole('tab')).toHaveLength(5);
    });

    it('renders nothing once the conversation has messages', () => {
      mockFlags = { conversationWorkflows: true };
      setStore({
        ...emptyConversation,
        messages: [
          { id: 'm1', role: 'user', content: 'hi' },
        ] as Conversation['messages'],
      });
      const { container } = render(<WorkflowTabs />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('rendering', () => {
    beforeEach(() => {
      mockFlags = { conversationWorkflows: true };
    });

    it('renders Chat plus the four workflows', () => {
      render(<WorkflowTabs />);
      expect(screen.getAllByRole('tab')).toHaveLength(5);
      expect(screen.getByRole('tab', { name: CHAT })).toBeInTheDocument();
      expect(
        screen.getByRole('tab', { name: TRANSLATION }),
      ).toBeInTheDocument();
    });

    it('marks Chat active on an untyped conversation', () => {
      render(<WorkflowTabs />);
      expect(screen.getByRole('tab', { name: CHAT })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: TRANSLATION })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });

    it('marks the conversation type active on a workflow conversation', () => {
      setStore({
        ...emptyConversation,
        conversationType: 'map',
        workflowState: {
          kind: 'map',
          features: [],
          sources: [],
          updatedAt: '',
        },
      });
      render(<WorkflowTabs />);
      expect(screen.getByRole('tab', { name: MAP })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: CHAT })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });

    it('shows a visible label on the active tab only', () => {
      render(<WorkflowTabs />);
      // Inactive tabs are icon-only; their name comes from aria-label.
      expect(screen.getByRole('tab', { name: CHAT })).toHaveTextContent(CHAT);
      expect(screen.getByRole('tab', { name: TRANSLATION })).toHaveTextContent(
        '',
      );
    });

    it('gives every tab an accessible name even when icon-only', () => {
      render(<WorkflowTabs />);
      for (const tab of screen.getAllByRole('tab')) {
        expect(tab.getAttribute('aria-label')).toBeTruthy();
      }
    });

    it('keeps the strip to a single tab stop', () => {
      render(<WorkflowTabs />);
      const focusable = screen
        .getAllByRole('tab')
        .filter((tab) => tab.getAttribute('tabindex') === '0');
      expect(focusable).toHaveLength(1);
      expect(focusable[0]).toHaveAttribute('aria-label', CHAT);
    });
  });

  describe('switching', () => {
    beforeEach(() => {
      mockFlags = { conversationWorkflows: true };
    });

    it('types the conversation when a workflow tab is clicked', () => {
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole('tab', { name: TRANSLATION }));

      expect(stored().conversationType).toBe('translation');
      expect(stored().workflowState?.kind).toBe('translation');
    });

    it('switches between workflows without confirming when untouched', () => {
      setStore({
        ...emptyConversation,
        conversationType: 'translation',
        workflowState: translationState(),
      });
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole('tab', { name: MAP }));

      expect(stored().conversationType).toBe('map');
      expect(stored().workflowState?.kind).toBe('map');
    });

    it('returns to plain chat and drops the workflow state', () => {
      setStore({
        ...emptyConversation,
        conversationType: 'translation',
        workflowState: translationState(),
      });
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole('tab', { name: CHAT }));

      expect(stored().conversationType).toBeUndefined();
      expect(stored().workflowState).toBeUndefined();
    });

    it('does nothing when the active tab is clicked', () => {
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole('tab', { name: CHAT }));
      expect(stored().conversationType).toBeUndefined();
    });
  });

  describe('discard confirmation', () => {
    const dirty = {
      ...emptyConversation,
      conversationType: 'translation' as const,
      workflowState: translationState({ sourceText: 'bonjour' }),
    };

    beforeEach(() => {
      mockFlags = { conversationWorkflows: true };
      setStore(dirty);
    });

    it('holds the switch until the user confirms', () => {
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole('tab', { name: MAP }));

      // Still translation: the dialog is open, nothing committed yet.
      expect(stored().conversationType).toBe('translation');
      expect(screen.getByText('discard.title')).toBeInTheDocument();
    });

    it('commits the switch on confirm', () => {
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole('tab', { name: MAP }));
      fireEvent.click(screen.getByRole('button', { name: 'discard.confirm' }));

      expect(stored().conversationType).toBe('map');
      expect(stored().workflowState?.kind).toBe('map');
    });

    it('leaves the workflow untouched on cancel', () => {
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole('tab', { name: MAP }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(stored().conversationType).toBe('translation');
      expect(
        (stored().workflowState as TranslationWorkflowState).sourceText,
      ).toBe('bonjour');
      expect(screen.queryByText('discard.title')).not.toBeInTheDocument();
    });

    it('also confirms before returning to plain chat', () => {
      render(<WorkflowTabs />);
      fireEvent.click(screen.getByRole('tab', { name: CHAT }));

      expect(stored().conversationType).toBe('translation');
      expect(screen.getByText('discard.title')).toBeInTheDocument();
    });
  });

  describe('keyboard', () => {
    beforeEach(() => {
      mockFlags = { conversationWorkflows: true };
    });

    it('moves focus with ArrowRight without switching', () => {
      render(<WorkflowTabs />);
      const chat = screen.getByRole('tab', { name: CHAT });
      chat.focus();
      fireEvent.keyDown(chat, { key: 'ArrowRight' });

      // Manual activation: arrowing must not fire a switch (which could
      // otherwise pop the discard dialog mid-navigation).
      expect(document.activeElement).toBe(
        screen.getByRole('tab', { name: TRANSLATION }),
      );
      expect(stored().conversationType).toBeUndefined();
    });

    it('wraps from the first tab to the last with ArrowLeft', () => {
      render(<WorkflowTabs />);
      const chat = screen.getByRole('tab', { name: CHAT });
      chat.focus();
      fireEvent.keyDown(chat, { key: 'ArrowLeft' });

      const tabs = screen.getAllByRole('tab');
      expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    });

    it('jumps to the last tab with End and the first with Home', () => {
      render(<WorkflowTabs />);
      const tabs = screen.getAllByRole('tab');
      tabs[0].focus();
      fireEvent.keyDown(tabs[0], { key: 'End' });
      expect(document.activeElement).toBe(tabs[tabs.length - 1]);

      fireEvent.keyDown(tabs[tabs.length - 1], { key: 'Home' });
      expect(document.activeElement).toBe(tabs[0]);
    });
  });
});

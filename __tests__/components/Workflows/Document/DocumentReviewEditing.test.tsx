import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { htmlToMarkdown } from '@/lib/utils/shared/document/exportUtils';
import { stampEditAnchors } from '@/lib/utils/shared/review/editLocation';
import { stringHash } from '@/lib/utils/shared/stringHash';

import { Conversation } from '@/types/chat';
import { DocumentWorkflowState } from '@/types/workflow';

import { DocumentWorkspace } from '@/components/Workflows/Document/DocumentWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Editing while a review is open (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §4).
 *
 * Two promises: text outside a suggestion is free to change and the queue
 * survives it; and a suggestion accepted AFTER the user has typed applies to
 * the document they now have — the markdown snapshot must not quietly
 * regenerate `docHtml` without their edit.
 */

vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream: vi.fn() }),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
vi.mock('@/client/services/workflows/documentAssessment', () => ({
  assessDocument: vi.fn(),
}));

const DOC_HTML = '<p>The clinic opened in March and stayed open.</p>';

function renderWorkspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DocumentWorkspace conversationId="doc-1" />
    </QueryClientProvider>,
  );
}

function seed() {
  const docMarkdown = htmlToMarkdown(DOC_HTML);
  const workflowState: DocumentWorkflowState = {
    kind: 'document',
    title: 'Clinic',
    docHtml: DOC_HTML,
    references: [],
    revisions: [],
    assessment: {
      id: 'a1',
      criteria: [],
      overallSummary: '',
      edits: stampEditAnchors(docMarkdown, [
        {
          id: 'e1',
          criterion: 'clarity',
          before: 'opened in March',
          after: 'opened in April',
          reason: 'Date was wrong',
          severity: 'minor' as const,
          status: 'pending' as const,
        },
      ]),
      docMarkdown,
      docHtmlHash: stringHash(DOC_HTML),
      scope: 'document',
      createdAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  useConversationStore.setState({
    conversations: [
      {
        id: 'doc-1',
        name: 'Clinic',
        messages: [],
        model: {
          id: 'gpt-4',
          name: 'GPT-4',
          maxLength: 4000,
          tokenLimit: 4000,
        },
        prompt: '',
        temperature: 0.5,
        folderId: null,
        conversationType: 'document',
        workflowState,
      } as unknown as Conversation,
    ],
    selectedConversationId: 'doc-1',
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

function state(): DocumentWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as DocumentWorkflowState;
}

function typeAt(pm: HTMLElement, offset: number, text: string) {
  const paragraph = pm.querySelector('p');
  if (!paragraph) throw new Error('no paragraph');
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node && remaining > (node.textContent?.length ?? 0)) {
    remaining -= node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  if (!node) throw new Error('offset past end');
  const range = document.createRange();
  range.setStart(node, remaining);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  pm.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }),
  );
}

async function mountWithMarks() {
  renderWorkspace();
  await waitFor(() =>
    expect(document.querySelector('.edit-suggestion-mark')).toBeTruthy(),
  );
  return document.querySelector('.ProseMirror') as HTMLElement;
}

describe('Document workflow — editing during a review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
    useSettingsStore.setState({
      reviewOverwriteAcknowledged: true,
      autoClearResolvedEdits: false,
    });
  });

  it('keeps the queue when text outside a suggestion is edited', async () => {
    const pm = await mountWithMarks();

    act(() => typeAt(pm, 3, 'X')); // inside "The"

    await waitFor(() => expect(state().docHtml).toContain('TheX'));
    expect(state().assessment?.edits[0].status).toBe('pending');
    // The suggestion is still marked where it now sits.
    expect(document.querySelector('.edit-suggestion-mark')).toBeTruthy();
  });

  it('applies an accepted suggestion to the document the user now has', async () => {
    const pm = await mountWithMarks();

    act(() => typeAt(pm, 3, 'X'));
    await waitFor(() => expect(state().docHtml).toContain('TheX'));

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() =>
      expect(state().assessment?.edits[0].status).toBe('accepted'),
    );
    // Both survive: the user's keystroke AND the accepted change.
    expect(state().docHtml).toContain('TheX');
    expect(state().docHtml).toContain('opened in April');
    expect(state().docHtml).not.toContain('March');
  });

  it('moves a suggestion to "not applied" when its passage is typed over', async () => {
    const pm = await mountWithMarks();

    act(() => typeAt(pm, 12, 'X')); // inside "opened"

    await waitFor(() =>
      expect(state().assessment?.edits[0].status).toBe('unapplicable'),
    );
    expect(state().docHtml).toContain('X');
  });

  it('holds the first such keystroke back until the rule has been explained', async () => {
    useSettingsStore.setState({ reviewOverwriteAcknowledged: false });
    const pm = await mountWithMarks();

    act(() => typeAt(pm, 12, 'X'));

    await waitFor(() =>
      expect(screen.getByText('Editing a suggested passage')).toBeTruthy(),
    );
    expect(state().docHtml).toBe(DOC_HTML);
    expect(state().assessment?.edits[0].status).toBe('pending');

    fireEvent.click(
      screen.getByRole('button', { name: 'Drop the suggestion and edit' }),
    );

    await waitFor(() =>
      expect(state().assessment?.edits[0].status).toBe('unapplicable'),
    );
    expect(useSettingsStore.getState().reviewOverwriteAcknowledged).toBe(true);
  });
});

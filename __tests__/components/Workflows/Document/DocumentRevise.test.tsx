import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Conversation } from '@/types/chat';
import { DocumentWorkflowState } from '@/types/workflow';

import { DocumentWorkspace } from '@/components/Workflows/Document/DocumentWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The workspace fetches admin guides via React Query (useAvailableGuides). */
function renderWorkspace(conversationId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DocumentWorkspace conversationId={conversationId} />
    </QueryClientProvider>,
  );
}

/** The markdown the model "returns" for the revise run. */
let modelOutput = '';

const runWorkflowStream = vi.hoisted(() => vi.fn());
vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream }),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
vi.mock('@/client/services/workflows/documentAssessment', () => ({
  assessDocument: vi.fn(),
}));

const DOC_MARKDOWN = `# Field Report

The clinic opened in March. Staffing reached twelve by June.

Supplies arrived late in the quarter.`;

const DOC_HTML =
  '<h1>Field Report</h1><p>The clinic opened in March. Staffing reached twelve by June.</p><p>Supplies arrived late in the quarter.</p>';

function seedConversation() {
  const workflowState: DocumentWorkflowState = {
    kind: 'document',
    title: 'Field Report',
    docHtml: DOC_HTML,
    references: [],
    revisions: [],
    updatedAt: new Date().toISOString(),
  };
  const conversation = {
    id: 'doc-1',
    name: 'Field Report',
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: '',
    temperature: 0.5,
    folderId: null,
    conversationType: 'document',
    workflowState,
  } as unknown as Conversation;
  useConversationStore.setState({
    conversations: [conversation],
    selectedConversationId: conversation.id,
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

function currentState(): DocumentWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as DocumentWorkflowState;
}

describe('Document workflow — revise as suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedConversation();
    useSettingsStore.setState({
      suggestRevisions: true,
      suggestRevisionsExceptions: {
        selectionScoped: true,
        largeRewrites: true,
        structuralReorders: true,
      },
      suggestRevisionsLargeRewriteRatio: 0.5,
    });
    // Deliver the model's document through onText, as the real stream does.
    runWorkflowStream.mockImplementation(async ({ onText }) => {
      onText?.(modelOutput, modelOutput);
    });
  });

  it('leaves the document untouched and queues suggestions', async () => {
    modelOutput = DOC_MARKDOWN.replace('twelve', 'fifteen');

    render(<DocumentWorkspace conversationId="doc-1" />);
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).toBeTruthy(),
    );

    const box = screen.getByPlaceholderText(/revise|describe/i);
    fireEvent.change(box, { target: { value: 'change twelve to fifteen' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(runWorkflowStream).toHaveBeenCalled());

    await waitFor(() => {
      const state = currentState();
      // The whole point: the document must NOT have been rewritten.
      expect(state.docHtml).toBe(DOC_HTML);
      expect(state.assessment?.edits.length).toBeGreaterThan(0);
      expect(state.assessment?.edits[0].status).toBe('pending');
    });
  });

  it('applies directly when the toggle is off', async () => {
    useSettingsStore.setState({ suggestRevisions: false });
    modelOutput = DOC_MARKDOWN.replace('twelve', 'fifteen');

    render(<DocumentWorkspace conversationId="doc-1" />);
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).toBeTruthy(),
    );

    const box = screen.getByPlaceholderText(/revise|describe/i);
    fireEvent.change(box, { target: { value: 'change twelve to fifteen' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      const state = currentState();
      expect(state.docHtml).not.toBe(DOC_HTML);
      expect(state.assessment).toBeUndefined();
    });
  });
});

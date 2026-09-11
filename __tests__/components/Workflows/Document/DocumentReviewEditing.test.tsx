import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';

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
 * The workspace's side of editing during a review
 * (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §4, §6a): what it does with the gate's
 * answer, and — the promise that matters most — that a suggestion accepted
 * AFTER the user has typed applies to the document they now have instead of
 * regenerating it from a stale snapshot.
 *
 * The editor is a stub. jsdom cannot deliver keystrokes to ProseMirror, and
 * the gate's mechanics have their own test against the real editor
 * (RichTextEditorOverwriteGate); here the stub reports typing the way the
 * real editor does: `onOverwriteEdits` first when a suggestion is in the way,
 * `onChange` with the new HTML when the change lands.
 */

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

const undo = vi.hoisted(() => vi.fn());
vi.mock('@/components/Workflows/Document/RichTextEditor', () => ({
  RichTextEditor: forwardRef(function StubEditor(
    props: {
      contentHtml: string;
      onChange: (html: string) => void;
      onOverwriteEdits?: (ids: string[]) => boolean;
      previewEdits?: readonly { id: string }[];
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      replaceRange: () => null,
      getHTML: () => props.contentHtml,
      insertText: () => true,
      undo,
    }));
    return (
      <div>
        <div data-testid="doc">{props.contentHtml}</div>
        <div data-testid="marks">{props.previewEdits?.length ?? 0}</div>
        <button
          type="button"
          onClick={() =>
            props.onChange(props.contentHtml.replace('The', 'TheX'))
          }
        >
          type-outside
        </button>
        <button
          type="button"
          onClick={() => {
            const ids = (props.previewEdits ?? []).map((e) => e.id);
            if (props.onOverwriteEdits?.(ids)) {
              props.onChange(props.contentHtml.replace('opened', 'opXened'));
            }
          }}
        >
          type-inside
        </button>
      </div>
    );
  }),
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

async function mountWithReview() {
  renderWorkspace();
  await waitFor(() =>
    expect(screen.getByTestId('marks').textContent).toBe('1'),
  );
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
    await mountWithReview();

    fireEvent.click(screen.getByText('type-outside'));

    await waitFor(() => expect(state().docHtml).toContain('TheX'));
    expect(state().assessment?.edits[0].status).toBe('pending');
    expect(screen.getByTestId('marks').textContent).toBe('1');
  });

  it('applies an accepted suggestion to the document the user now has', async () => {
    await mountWithReview();

    fireEvent.click(screen.getByText('type-outside'));
    await waitFor(() => expect(state().docHtml).toContain('TheX'));

    fireEvent.click(screen.getByRole('button', { name: 'acceptEdit' }));

    await waitFor(() =>
      expect(state().assessment?.edits[0].status).toBe('accepted'),
    );
    // Both survive: the user's keystroke AND the accepted change. Before the
    // unfreeze this regenerated docHtml from the snapshot and lost the X.
    expect(state().docHtml).toContain('TheX');
    expect(state().docHtml).toContain('opened in April');
    expect(state().docHtml).not.toContain('March');
  });

  it('moves a suggestion to "not applied" when its passage is typed over', async () => {
    await mountWithReview();

    fireEvent.click(screen.getByText('type-inside'));

    await waitFor(() =>
      expect(state().assessment?.edits[0].status).toBe('unapplicable'),
    );
    expect(state().docHtml).toContain('opXened');
    expect(screen.getByTestId('marks').textContent).toBe('0');
  });

  it('holds the first such keystroke back until the rule has been explained', async () => {
    useSettingsStore.setState({ reviewOverwriteAcknowledged: false });
    await mountWithReview();

    fireEvent.click(screen.getByText('type-inside'));

    await waitFor(() =>
      expect(screen.getByText('document.overwriteEditTitle')).toBeTruthy(),
    );
    // Held back: nothing changed yet.
    expect(state().docHtml).toBe(DOC_HTML);
    expect(state().assessment?.edits[0].status).toBe('pending');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'document.overwriteEditConfirmOne',
      }),
    );

    await waitFor(() =>
      expect(state().assessment?.edits[0].status).toBe('unapplicable'),
    );
    expect(useSettingsStore.getState().reviewOverwriteAcknowledged).toBe(true);
  });

  it('leaves everything as it was when the explanation is cancelled', async () => {
    useSettingsStore.setState({ reviewOverwriteAcknowledged: false });
    await mountWithReview();

    fireEvent.click(screen.getByText('type-inside'));
    await waitFor(() =>
      expect(screen.getByText('document.overwriteEditTitle')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(state().docHtml).toBe(DOC_HTML);
    expect(state().assessment?.edits[0].status).toBe('pending');
    expect(useSettingsStore.getState().reviewOverwriteAcknowledged).toBe(false);
  });

  describe('AI run while suggestions are pending (§6b)', () => {
    async function askForRevision() {
      await mountWithReview();
      const box = screen.getByPlaceholderText('document.revisePlaceholder');
      fireEvent.change(box, { target: { value: 'tighten the prose' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'acceptAll' })).toBeTruthy(),
      );
    }

    it('gates the run behind the three-action dialog', async () => {
      await askForRevision();

      expect(runWorkflowStream).not.toHaveBeenCalled();
      expect(state().assessment?.edits[0].status).toBe('pending');
    });

    it('accept-all runs against the POST-decision text', async () => {
      // The run itself replaces the review afterwards (a revision produces a
      // fresh queue), so the state that matters is the state AT the moment
      // the run fires — captured from inside the mock.
      let statusAtRun: string | undefined;
      runWorkflowStream.mockImplementation(async () => {
        statusAtRun = state().assessment?.edits[0]?.status;
      });
      await askForRevision();

      fireEvent.click(screen.getByRole('button', { name: 'acceptAll' }));

      await waitFor(() => expect(runWorkflowStream).toHaveBeenCalled());
      expect(statusAtRun).toBe('accepted');
      // The stale-closure trap: had the run fired from the dialog handler it
      // would have read the render's old docHtml and sent "March".
      const body = runWorkflowStream.mock.calls[0][0].body as {
        currentDocMarkdown?: string;
      };
      expect(body.currentDocMarkdown).toContain('opened in April');
      expect(body.currentDocMarkdown).not.toContain('March');
    });

    it('reject-all clears the queue and runs with the text unchanged', async () => {
      let statusAtRun: string | undefined;
      let docAtRun: string | undefined;
      runWorkflowStream.mockImplementation(async () => {
        statusAtRun = state().assessment?.edits[0]?.status;
        docAtRun = state().docHtml;
      });
      await askForRevision();

      fireEvent.click(screen.getByRole('button', { name: 'rejectAll' }));

      await waitFor(() => expect(runWorkflowStream).toHaveBeenCalled());
      expect(statusAtRun).toBe('rejected');
      expect(docAtRun).toBe(DOC_HTML);
    });

    it('cancel runs nothing and keeps the queue', async () => {
      await askForRevision();

      fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'acceptAll' })).toBeNull(),
      );
      expect(runWorkflowStream).not.toHaveBeenCalled();
      expect(state().assessment?.edits[0].status).toBe('pending');
    });
  });
});

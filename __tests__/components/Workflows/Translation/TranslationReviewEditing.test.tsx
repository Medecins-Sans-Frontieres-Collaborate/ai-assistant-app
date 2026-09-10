import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { stampEditAnchors } from '@/lib/utils/shared/review/editLocation';

import { Conversation } from '@/types/chat';
import { TranslationWorkflowState } from '@/types/workflow';

import { TranslationWorkspace } from '@/components/Workflows/Translation/TranslationWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Editing the translation while a review is open
 * (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §5, §6a). The target pane is a plain
 * textarea, so unlike the document these tests type for real.
 */

const runWorkflowStream = vi.hoisted(() => vi.fn());
vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream }),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
vi.mock('@/client/services/workflows/translationAssessment', () => ({
  assessTranslation: vi.fn(),
}));

const FINAL = 'La clinique a ouvert en mars et est restée ouverte.';

function renderWorkspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TranslationWorkspace conversationId="tr-1" />
    </QueryClientProvider>,
  );
}

function seed() {
  const workflowState: TranslationWorkflowState = {
    kind: 'translation',
    sourceText: 'The clinic opened in March and stayed open.',
    targetLanguage: { id: 'fr', label: 'French' },
    mode: 'quick',
    rounds: [],
    finalText: FINAL,
    assessment: {
      id: 'a1',
      criteria: [],
      overallSummary: '',
      edits: stampEditAnchors(FINAL, [
        {
          id: 'e1',
          criterion: 'accuracy',
          before: 'ouvert en mars',
          after: 'ouvert en avril',
          reason: 'Date was wrong',
          severity: 'minor' as const,
          status: 'pending' as const,
        },
        {
          id: 'e2',
          criterion: 'fluency',
          before: 'restée ouverte',
          after: 'restée en activité',
          reason: 'Reads better',
          severity: 'minor' as const,
          status: 'pending' as const,
        },
      ]),
      createdAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  useConversationStore.setState({
    conversations: [
      {
        id: 'tr-1',
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
        conversationType: 'translation',
        workflowState,
      } as unknown as Conversation,
    ],
    selectedConversationId: 'tr-1',
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

function state(): TranslationWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as TranslationWorkflowState;
}

/** Enters edit mode and returns the translation textarea. */
async function openEditor(): Promise<HTMLTextAreaElement> {
  renderWorkspace();
  const toggle = await screen.findByRole('button', {
    name: 'translation.editTranslation',
  });
  expect(toggle).not.toBeDisabled();
  fireEvent.click(toggle);
  return (await screen.findByPlaceholderText(
    'translation.pasteTranslationPlaceholder',
  )) as HTMLTextAreaElement;
}

describe('Translation workflow — editing during a review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
    useSettingsStore.setState({
      reviewOverwriteAcknowledged: true,
      autoClearResolvedEdits: false,
    });
  });

  it('keeps the queue when text outside a suggestion is edited', async () => {
    const box = await openEditor();

    fireEvent.change(box, {
      target: { value: FINAL.replace('clinique', 'Xclinique') },
    });

    await waitFor(() => expect(state().finalText).toContain('Xclinique'));
    expect(state().assessment?.edits[0].status).toBe('pending');
  });

  it('applies an accepted suggestion to the text the user now has', async () => {
    const box = await openEditor();
    fireEvent.change(box, {
      target: { value: FINAL.replace('clinique', 'Xclinique') },
    });
    await waitFor(() => expect(state().finalText).toContain('Xclinique'));

    fireEvent.click(screen.getAllByRole('button', { name: 'acceptEdit' })[0]);

    await waitFor(() =>
      expect(state().assessment?.edits[0].status).toBe('accepted'),
    );
    expect(state().finalText).toContain('Xclinique');
    expect(state().finalText).toContain('ouvert en avril');
  });

  it('moves a suggestion to "not applied" when its passage is typed over', async () => {
    const box = await openEditor();

    fireEvent.change(box, {
      target: { value: FINAL.replace('ouvert', 'ouXvert') },
    });

    await waitFor(() =>
      expect(state().assessment?.edits[0].status).toBe('unapplicable'),
    );
    expect(state().finalText).toContain('ouXvert');
    // Exactly one: the other suggestion's passage was not touched.
    expect(state().assessment?.edits[1].status).toBe('pending');
  });

  it('holds the first such change back, then applies it once explained', async () => {
    useSettingsStore.setState({ reviewOverwriteAcknowledged: false });
    const box = await openEditor();

    const next = FINAL.replace('ouvert', 'ouXvert');
    fireEvent.change(box, { target: { value: next } });

    await waitFor(() =>
      expect(screen.getByText('translation.overwriteEditTitle')).toBeTruthy(),
    );
    // Held back: the translation is untouched and the queue intact.
    expect(state().finalText).toBe(FINAL);
    expect(state().assessment?.edits[0].status).toBe('pending');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'translation.overwriteEditConfirmOne',
      }),
    );

    await waitFor(() =>
      expect(state().assessment?.edits[0].status).toBe('unapplicable'),
    );
    // Nothing typed was lost: the held change is what landed.
    expect(state().finalText).toBe(next);
    expect(useSettingsStore.getState().reviewOverwriteAcknowledged).toBe(true);
  });

  it('leaves everything as it was when the explanation is cancelled', async () => {
    useSettingsStore.setState({ reviewOverwriteAcknowledged: false });
    const box = await openEditor();

    fireEvent.change(box, {
      target: { value: FINAL.replace('ouvert', 'ouXvert') },
    });
    await waitFor(() =>
      expect(screen.getByText('translation.overwriteEditTitle')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(state().finalText).toBe(FINAL);
    expect(state().assessment?.edits[0].status).toBe('pending');
    expect(useSettingsStore.getState().reviewOverwriteAcknowledged).toBe(false);
  });

  describe('AI run while suggestions are pending (§6b)', () => {
    async function askToTranslate() {
      renderWorkspace();
      const translate = await screen.findByRole('button', {
        name: 'translation.translate',
      });
      expect(translate).not.toBeDisabled();
      fireEvent.click(translate);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    }

    const dialog = () => within(screen.getByRole('dialog'));

    it('gates the run behind the three-action dialog', async () => {
      await askToTranslate();

      expect(runWorkflowStream).not.toHaveBeenCalled();
      expect(state().assessment?.edits[0].status).toBe('pending');
    });

    /**
     * A fresh translation resets the paper trail — assessment and finalText
     * included — before it streams, so nothing can be read at run time. The
     * store is watched as the decision lands instead, and two things are
     * asserted: what the text looked like the moment it was decided, and
     * that the decision came BEFORE the run.
     */
    function watchDecisions() {
      const seen: { status: string; text: string | undefined }[] = [];
      const unsubscribe = useConversationStore.subscribe((store) => {
        const ws = store.conversations[0]?.workflowState as
          | TranslationWorkflowState
          | undefined;
        const status = ws?.assessment?.edits[0]?.status;
        if (status && seen[seen.length - 1]?.status !== status) {
          seen.push({ status, text: ws?.finalText });
        }
      });
      return { seen, unsubscribe };
    }

    it('accept-all decides the queue, then translates', async () => {
      let decidedBeforeRun = false;
      const watch = watchDecisions();
      runWorkflowStream.mockImplementation(async () => {
        decidedBeforeRun = watch.seen.some((s) => s.status === 'accepted');
      });
      await askToTranslate();

      fireEvent.click(dialog().getByRole('button', { name: 'acceptAll' }));

      await waitFor(() => expect(runWorkflowStream).toHaveBeenCalled());
      watch.unsubscribe();
      expect(decidedBeforeRun).toBe(true);
      const accepted = watch.seen.find((s) => s.status === 'accepted');
      expect(accepted?.text).toContain('ouvert en avril');
    });

    it('reject-all decides the queue, then translates', async () => {
      let decidedBeforeRun = false;
      const watch = watchDecisions();
      runWorkflowStream.mockImplementation(async () => {
        decidedBeforeRun = watch.seen.some((s) => s.status === 'rejected');
      });
      await askToTranslate();

      fireEvent.click(dialog().getByRole('button', { name: 'rejectAll' }));

      await waitFor(() => expect(runWorkflowStream).toHaveBeenCalled());
      watch.unsubscribe();
      expect(decidedBeforeRun).toBe(true);
      const rejected = watch.seen.find((s) => s.status === 'rejected');
      expect(rejected?.text).toBe(FINAL);
    });

    it('cancel runs nothing and keeps the queue', async () => {
      await askToTranslate();

      fireEvent.click(dialog().getByRole('button', { name: 'cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(runWorkflowStream).not.toHaveBeenCalled();
      expect(state().assessment?.edits[0].status).toBe('pending');
    });
  });
});

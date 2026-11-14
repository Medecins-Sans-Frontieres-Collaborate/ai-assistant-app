import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { Conversation } from '@/types/chat';
import {
  TranslationAssessment,
  TranslationWorkflowState,
} from '@/types/workflow';

import { TranslationWorkspace } from '@/components/Workflows/Translation/TranslationWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useWorkflowRailStore } from '@/client/stores/workflowRailStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream: vi.fn() }),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
// Keys are rendered as-is, with their values appended, so assertions name
// the string and what it was given.
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

const CONVERSATION_ID = 'change-request';
const SOURCE = 'Take 1 tab daily. Treat malaria early.';
const TRANSLATION = 'Tome 1 comprimido al día. Trate la malaria pronto.';
const REVISE_URL = '/api/workflows/translation/revise';
const fetchMock = vi.fn();
let reviseResponse: (init: RequestInit) => Promise<Response>;

const envelope = (data: unknown, status = 200) =>
  Response.json({ success: true, data }, { status });
const twoEdits = () =>
  Promise.resolve(
    envelope({
      reply: 'I suggest two changes.',
      edits: [
        { before: '1 comprimido', after: '1 tableta', reason: 'term' },
        { before: 'pronto', after: 'de forma precoz', reason: 'formal' },
      ],
    }),
  );

const conversation = () => useConversationStore.getState().conversations[0];
const state = () => conversation().workflowState as TranslationWorkflowState;
const reviseCalls = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === REVISE_URL)
    .map(([, init]) => JSON.parse(init.body as string));
const messages = () => conversation().messages.map((m) => m.content);

const pendingAssessment: TranslationAssessment = {
  id: 'a1',
  criteria: [{ criterionId: 'accuracy', rating: 3, summary: 's' }],
  overallSummary: 'earlier assessment',
  edits: [
    {
      id: 'e1',
      criterion: 'accuracy',
      before: 'Tome',
      after: 'Tomar',
      reason: 'r',
      severity: 'minor',
      status: 'pending',
    },
  ],
  createdAt: '2026-11-14T10:00:00.000Z',
};

function mountWorkspace(overrides: Partial<TranslationWorkflowState> = {}) {
  const workflowState: TranslationWorkflowState = {
    kind: 'translation',
    sourceText: SOURCE,
    targetLanguage: { id: 'es', label: 'Spanish' },
    mode: 'quick',
    rounds: [],
    finalText: TRANSLATION,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  useConversationStore.setState({
    conversations: [
      {
        id: CONVERSATION_ID,
        name: 'Translation',
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
    selectedConversationId: CONVERSATION_ID,
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TranslationWorkspace conversationId={CONVERSATION_ID} />
    </QueryClientProvider>,
  );
}

const bar = () =>
  screen.getByLabelText('translation.changeLabel') as HTMLInputElement;
function ask(instruction: string) {
  fireEvent.change(bar(), { target: { value: instruction } });
  fireEvent.click(
    screen.getByRole('button', { name: 'translation.changeSend' }),
  );
}
/** Parks an instruction the way the rail's send module does. */
function askFromRail(text: string, signal?: AbortSignal) {
  const settle = vi.fn();
  act(() => {
    useWorkflowRailStore.getState().submitWorkspaceRequest(CONVERSATION_ID, {
      id: 'r1',
      text,
      signal,
      settle,
    });
  });
  return settle;
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkflowRailStore.setState({ workspaceRequests: {} });
  reviseResponse = twoEdits;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === REVISE_URL) return reviseResponse(init!);
    return Promise.resolve(Response.json({ data: { guides: [] } }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('asking for a change from the workspace', () => {
  it('offers the bar only once there is a translation', () => {
    const { unmount } = mountWorkspace({ finalText: undefined });
    expect(screen.queryByLabelText('translation.changeLabel')).toBeNull();
    unmount();
    mountWorkspace();
    expect(bar()).toHaveAttribute(
      'placeholder',
      'translation.changePlaceholder',
    );
    expect(
      screen.getByRole('button', { name: 'translation.changeSend' }),
    ).toBeDisabled();
  });

  it('sends the instruction with the texts and shows the edits without applying them', async () => {
    mountWorkspace();
    ask('  Say tableta and be formal  ');
    expect(
      await screen.findByText('translation.changeTitle'),
    ).toBeInTheDocument();
    expect(reviseCalls()).toEqual([
      expect.objectContaining({
        instruction: 'Say tableta and be formal',
        sourceText: SOURCE,
        translation: TRANSLATION,
        targetLanguage: 'Spanish',
        conversationId: CONVERSATION_ID,
      }),
    ]);
    expect(screen.getByText('Say tableta and be formal')).toBeInTheDocument();
    expect(screen.getByText('I suggest two changes.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'acceptEdit' })).toHaveLength(
      2,
    );
    // Requested edits answer an instruction, not a rubric: no chips.
    expect(screen.queryByText('severity.minor')).toBeNull();
    expect(state().finalText).toBe(TRANSLATION);
    expect(state().assessment).toMatchObject({
      criteria: [],
      request: { instruction: 'Say tableta and be formal' },
    });
    expect(state().assessment!.edits.map((e) => e.status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(bar()).toHaveAttribute(
      'placeholder',
      'translation.changePlaceholderAnother',
    );
    expect(messages()).toEqual([
      'Say tableta and be formal',
      'I suggest two changes.\n\ntranslation.changeReplyPending 2',
    ]);
  });

  it('changes the translation only for the edit that is accepted', async () => {
    mountWorkspace();
    ask('Say tableta');
    const accept = await screen.findAllByRole('button', { name: 'acceptEdit' });
    fireEvent.click(accept[0]);
    expect(state().finalText).toBe(
      'Tome 1 tableta al día. Trate la malaria pronto.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'rejectEdit' }));
    expect(state().finalText).toBe(
      'Tome 1 tableta al día. Trate la malaria pronto.',
    );
    expect(state().assessment!.edits.map((e) => e.status)).toEqual([
      'accepted',
      'rejected',
    ]);
  });

  it('shows progress with a way to stop, and treats stopping as a decision', async () => {
    reviseResponse = (init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    mountWorkspace();
    ask('Be formal');
    expect(
      await screen.findByText(/translation.changeWorking/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/translation.changeNothingApplied/),
    ).toBeInTheDocument();
    expect(bar()).toBeDisabled();
    expect(bar().value).toBe('Be formal');
    fireEvent.click(screen.getByRole('button', { name: 'translation.stop' }));
    await waitFor(() => expect(bar()).not.toBeDisabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(state().assessment).toBeUndefined();
    expect(messages()).toEqual(['Be formal', 'translation.changeStopped']);
  });

  it('shows the reply and keeps the review column when nothing needs changing', async () => {
    reviseResponse = () =>
      Promise.resolve(
        envelope({ reply: 'It already says tableta.', edits: [] }),
      );
    const resolved: TranslationAssessment = {
      ...pendingAssessment,
      edits: [{ ...pendingAssessment.edits[0], status: 'rejected' }],
    };
    mountWorkspace({ assessment: resolved });
    ask('Say tableta');
    expect(
      await screen.findByText('It already says tableta.'),
    ).toBeInTheDocument();
    expect(state().assessment).toEqual(resolved);
    expect(messages()).toEqual(['Say tableta', 'It already says tableta.']);
  });

  it('reports a failed request in place', async () => {
    reviseResponse = () =>
      Promise.resolve(
        Response.json(
          { success: false, error: 'Text is too long' },
          { status: 400 },
        ),
      );
    mountWorkspace();
    ask('Be formal');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Text is too long',
    );
    expect(state().assessment).toBeUndefined();
  });
});

describe('asking while suggestions are still pending', () => {
  it('asks for a decision first, then sends the request against the decided text', async () => {
    mountWorkspace({ assessment: pendingAssessment });
    ask('Say tableta');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('translation.pendingRunActionRequest');
    expect(reviseCalls()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'acceptAll' }));
    await waitFor(() => expect(reviseCalls()).toHaveLength(1));
    // The accepted suggestion is in the text the model is asked about.
    expect(reviseCalls()[0].translation).toBe(
      'Tomar 1 comprimido al día. Trate la malaria pronto.',
    );
    expect(
      await screen.findByText('translation.changeTitle'),
    ).toBeInTheDocument();
  });

  it('sends nothing when the dialog is cancelled', async () => {
    mountWorkspace({ assessment: pendingAssessment });
    ask('Say tableta');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(reviseCalls()).toHaveLength(0);
    expect(state().assessment).toEqual(pendingAssessment);
  });
});

describe('an instruction typed in the conversation rail', () => {
  it('runs in the workspace and hands the reply back to the rail', async () => {
    mountWorkspace();
    const settle = askFromRail('Say tableta');
    await waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
    expect(settle).toHaveBeenCalledWith(
      'I suggest two changes.\n\ntranslation.changeReplyPending 2',
    );
    expect(reviseCalls()).toHaveLength(1);
    expect(reviseCalls()[0].instruction).toBe('Say tableta');
    expect(screen.getByText('translation.changeTitle')).toBeInTheDocument();
    // The rail writes its own messages; the workspace must not add a second pair.
    expect(messages()).toEqual([]);
    expect(
      useWorkflowRailStore.getState().workspaceRequests[CONVERSATION_ID],
    ).toBeUndefined();
  });

  it('answers a question without touching the review column or the bar', async () => {
    reviseResponse = () =>
      Promise.resolve(envelope({ reply: 'PO means by mouth.', edits: [] }));
    mountWorkspace();
    const settle = askFromRail('Why via oral?');
    await waitFor(() =>
      expect(settle).toHaveBeenCalledWith('PO means by mouth.'),
    );
    expect(state().assessment).toBeUndefined();
    expect(screen.queryByText('PO means by mouth.')).toBeNull();
  });

  it('says so when there is no translation yet, without calling the server', async () => {
    mountWorkspace({ finalText: undefined });
    const settle = askFromRail('Be formal');
    await waitFor(() =>
      expect(settle).toHaveBeenCalledWith('translation.changeNoTranslation'),
    );
    expect(reviseCalls()).toHaveLength(0);
  });

  it('tells the rail when the pending-suggestions dialog is cancelled', async () => {
    mountWorkspace({ assessment: pendingAssessment });
    const settle = askFromRail('Say tableta');
    const dialog = await screen.findByRole('dialog');
    expect(settle).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'cancel' }));
    await waitFor(() =>
      expect(settle).toHaveBeenCalledWith('translation.changeHeld'),
    );
    expect(reviseCalls()).toHaveLength(0);
  });

  it('stops when the rail stop button aborts, and reports the failure text otherwise', async () => {
    reviseResponse = (init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    mountWorkspace();
    const railStop = new AbortController();
    const settle = askFromRail('Be formal', railStop.signal);
    await screen.findByText(/translation.changeWorking/);
    act(() => railStop.abort());
    await waitFor(() =>
      expect(settle).toHaveBeenCalledWith('translation.changeStopped'),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

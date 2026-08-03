import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { M365_BUILTIN_SERVER_ID } from '@/lib/services/m365/tools/toolCatalog';

import type { ToolApprovalRule } from '@/lib/utils/shared/chat/toolApprovalRules';

import { Conversation } from '@/types/chat';

import { ApprovalConsentCard } from '@/components/Chat/ChatMessages/ApprovalConsentCard';
import type { ConsentRequest } from '@/components/Chat/ChatMessages/ConsentCard';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ALWAYS_CONFIRM_NOTE =
  'This action always asks for confirmation — it can’t be auto-approved.';

// The mail renderer reads the signed-in user's mail domain via useSession
// for external-recipient badges; this override replaces the global setup
// mock (which returns no session) with a per-test controllable one.
const sessionMailRef = vi.hoisted(() => ({
  current: 'me@contoso.com' as string | null,
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: sessionMailRef.current
      ? { user: { mail: sessionMailRef.current } }
      : null,
    status: sessionMailRef.current ? 'authenticated' : 'unauthenticated',
  }),
  signIn: vi.fn(),
  signOut: vi.fn(),
  SessionProvider: ({ children }: { children: ReactNode }) => children,
}));

type ApprovalRequest = ConsentRequest & { kind: 'approval' };

/** A normal (rule-respecting) native-MCP approval request. */
function normalApproval(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    kind: 'approval',
    approval_request_id: 'req-1',
    server_id: 'srv-1',
    server_label: 'GitHub',
    tool_name: 'create_issue',
    tool_arguments: '{"title":"Bug"}',
    ...overrides,
  };
}

/** A first-party M365 write tool — must confirm on every call. */
function m365WriteApproval(): ApprovalRequest {
  return normalApproval({
    server_id: M365_BUILTIN_SERVER_ID,
    server_label: 'Microsoft 365',
    tool_name: 'calendar_create_event',
    tool_arguments: '{"subject":"Sync","startDateTime":"2026-08-03T14:00:00"}',
  });
}

function rule(
  toolName: string,
  action: 'approve' | 'reject',
): ToolApprovalRule {
  return {
    id: `rule-${toolName}-${action}`,
    toolName,
    action,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

const CONVERSATION = {
  id: 'conv-1',
  name: 'test',
  messages: [],
  model: { id: 'gpt-5.2', name: 'GPT' },
  prompt: '',
  temperature: 0.5,
  folderId: null,
} as unknown as Conversation;

describe('ApprovalConsentCard — M365 always-confirm semantics', () => {
  const submitApproval = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    submitApproval.mockClear();
    useChatStore.setState({
      submittedApprovals: new Map(),
      submittingApprovals: new Set(),
      failedApprovals: new Set(),
      isStreaming: false,
      submitApproval,
    });
    useConversationStore.setState({
      conversations: [CONVERSATION],
      selectedConversationId: CONVERSATION.id,
    });
    useSettingsStore.setState({ toolApprovalRules: [] });
  });

  it('still renders and does not auto-submit despite a matching global APPROVE rule', () => {
    useSettingsStore.setState({
      toolApprovalRules: [rule('calendar_create_event', 'approve')],
    });

    render(
      <ApprovalConsentCard request={m365WriteApproval()} messageIndex={1} />,
    );

    expect(submitApproval).not.toHaveBeenCalled();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    // The concrete payload stays visible for review.
    expect(screen.getByText(/"Sync"/)).toBeInTheDocument();
  });

  it('auto-denies on a matching global REJECT rule (reject still wins)', async () => {
    useSettingsStore.setState({
      toolApprovalRules: [rule('calendar_create_event', 'reject')],
    });

    render(
      <ApprovalConsentCard request={m365WriteApproval()} messageIndex={1} />,
    );

    await waitFor(() => expect(submitApproval).toHaveBeenCalledTimes(1));
    expect(submitApproval).toHaveBeenCalledWith(
      'req-1',
      false,
      expect.objectContaining({ id: 'conv-1' }),
      1,
      'auto-denied',
    );
  });

  it('ignores per-conversation alwaysApproveAllTools — the card still renders', () => {
    useConversationStore.setState({
      conversations: [
        { ...CONVERSATION, alwaysApproveAllTools: true } as Conversation,
      ],
    });

    render(
      <ApprovalConsentCard request={m365WriteApproval()} messageIndex={1} />,
    );

    expect(submitApproval).not.toHaveBeenCalled();
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });

  it('ignores per-conversation alwaysApproveTools listing the tool', () => {
    useConversationStore.setState({
      conversations: [
        {
          ...CONVERSATION,
          alwaysApproveTools: ['calendar_create_event'],
        } as Conversation,
      ],
    });

    render(
      <ApprovalConsentCard request={m365WriteApproval()} messageIndex={1} />,
    );

    expect(submitApproval).not.toHaveBeenCalled();
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });

  it('offers no "always" approve options for an always-confirm tool, but keeps deny-everywhere', () => {
    render(
      <ApprovalConsentCard request={m365WriteApproval()} messageIndex={1} />,
    );

    // No approve scope menu at all — plain once-approval only.
    expect(screen.queryByLabelText('Approve options')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Always approve this tool'),
    ).not.toBeInTheDocument();

    // Deny side unchanged: the menu still offers "never allow".
    fireEvent.click(screen.getByLabelText('Deny options'));
    expect(
      screen.getByText('Never allow this tool — in every chat'),
    ).toBeInTheDocument();
  });

  it('offers the full approve scope menu for a normal tool', () => {
    render(<ApprovalConsentCard request={normalApproval()} messageIndex={1} />);

    fireEvent.click(screen.getByLabelText('Approve options'));

    expect(screen.getByText('Approve once')).toBeInTheDocument();
    expect(screen.getByText('Always approve this tool')).toBeInTheDocument();
    expect(screen.getByText('Always approve all tools')).toBeInTheDocument();
    expect(
      screen.getByText('Always approve this tool — in every chat'),
    ).toBeInTheDocument();
  });

  it('renders the always-confirm note for M365 write tools only', () => {
    const { unmount } = render(
      <ApprovalConsentCard request={m365WriteApproval()} messageIndex={1} />,
    );
    expect(screen.getByText(ALWAYS_CONFIRM_NOTE)).toBeInTheDocument();
    unmount();

    render(<ApprovalConsentCard request={normalApproval()} messageIndex={1} />);
    expect(screen.queryByText(ALWAYS_CONFIRM_NOTE)).not.toBeInTheDocument();
  });

  it('regression: a normal tool with a matching APPROVE rule still auto-approves', async () => {
    useSettingsStore.setState({
      toolApprovalRules: [rule('create_issue', 'approve')],
    });

    const { container } = render(
      <ApprovalConsentCard request={normalApproval()} messageIndex={1} />,
    );

    await waitFor(() => expect(submitApproval).toHaveBeenCalledTimes(1));
    expect(submitApproval).toHaveBeenCalledWith(
      'req-1',
      true,
      expect.objectContaining({ id: 'conv-1' }),
      1,
      'auto-approved',
    );
    // Auto-approved cards suppress themselves; the tool summary shows them.
    expect(container).toBeEmptyDOMElement();
  });
});

/** A builtin-M365 mail write with the given tool arguments. */
function mailApproval(
  toolName: string,
  args: Record<string, unknown>,
): ApprovalRequest {
  return normalApproval({
    server_id: M365_BUILTIN_SERVER_ID,
    server_label: 'Microsoft 365',
    tool_name: toolName,
    tool_arguments: JSON.stringify(args),
  });
}

describe('ApprovalConsentCard — mail payload renderer', () => {
  const submitApproval = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    submitApproval.mockClear();
    sessionMailRef.current = 'me@contoso.com';
    useChatStore.setState({
      submittedApprovals: new Map(),
      submittingApprovals: new Set(),
      failedApprovals: new Set(),
      isStreaming: false,
      submitApproval,
    });
    useConversationStore.setState({
      conversations: [CONVERSATION],
      selectedConversationId: CONVERSATION.id,
    });
    useSettingsStore.setState({ toolApprovalRules: [] });
  });

  it('renders grouped To/Cc/Bcc chips with external badges from the session mail domain', () => {
    render(
      <ApprovalConsentCard
        request={mailApproval('mail_create_draft', {
          to: ['ana@contoso.com', 'bob@evil.com'],
          cc: ['sec@contoso.com'],
          bcc: ['hidden@other.org'],
          subject: 'Quarterly numbers',
          body: 'First line of the body.\n\nTHE VERY END',
        })}
        messageIndex={1}
      />,
    );

    expect(screen.getByText('To')).toBeInTheDocument();
    expect(screen.getByText('Cc')).toBeInTheDocument();
    expect(screen.getByText('Bcc')).toBeInTheDocument();
    expect(screen.getByText(/ana@contoso\.com/)).toBeInTheDocument();
    expect(screen.getByText(/bob@evil\.com/)).toBeInTheDocument();
    // Exactly the two off-domain recipients are badged.
    expect(screen.getAllByText('External')).toHaveLength(2);
    expect(screen.getByText('Quarterly numbers')).toBeInTheDocument();
    // The generic JSON pre is replaced by the structured view.
    expect(screen.queryByText('mail_create_draft')).not.toBeInTheDocument();
  });

  it('renders the FULL body without elision', () => {
    const paragraphs = Array.from(
      { length: 80 },
      (_, i) => `Paragraph ${i} of a very long draft body.`,
    );
    render(
      <ApprovalConsentCard
        request={mailApproval('mail_create_draft', {
          to: ['ana@contoso.com'],
          subject: 'Long one',
          body: `${paragraphs.join('\n\n')}\n\nTHE VERY END`,
        })}
        messageIndex={1}
      />,
    );

    expect(screen.getByText(/Paragraph 0 of a very long/)).toBeInTheDocument();
    expect(screen.getByText(/Paragraph 79 of a very long/)).toBeInTheDocument();
    expect(screen.getByText(/THE VERY END/)).toBeInTheDocument();
  });

  it('shows no external badges when the session mail is unknown', () => {
    sessionMailRef.current = null;
    render(
      <ApprovalConsentCard
        request={mailApproval('mail_create_draft', {
          to: ['bob@evil.com'],
          subject: 'Hi',
          body: 'Body',
        })}
        messageIndex={1}
      />,
    );

    // No badges rather than wrong ones — but the chip itself still renders.
    expect(screen.getByText(/bob@evil\.com/)).toBeInTheDocument();
    expect(screen.queryByText('External')).not.toBeInTheDocument();
  });

  it('calls out reply-all prominently on reply drafts', () => {
    render(
      <ApprovalConsentCard
        request={mailApproval('mail_create_reply_draft', {
          messageId: 'msg-1',
          body: 'Reply body text',
          replyAll: true,
        })}
        messageIndex={1}
      />,
    );

    expect(
      screen.getByText(
        'Reply-all — this reply goes to everyone on the original message.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Reply body text/)).toBeInTheDocument();
  });

  it('shows the file name and target draft for attachment cards', () => {
    render(
      <ApprovalConsentCard
        request={mailApproval('mail_add_draft_attachment', {
          draftId: 'draft-9',
          fileUri: '/api/file/a-1.pdf',
          fileName: 'minutes.pdf',
        })}
        messageIndex={1}
      />,
    );

    expect(screen.getByText('Attach file: minutes.pdf')).toBeInTheDocument();
    expect(screen.getByText('Draft: draft-9')).toBeInTheDocument();
  });

  it('regression: mail writes keep always-confirm semantics (no approve-scope menu)', () => {
    render(
      <ApprovalConsentCard
        request={mailApproval('mail_create_draft', {
          to: ['ana@contoso.com'],
          subject: 'Hi',
          body: 'Body',
        })}
        messageIndex={1}
      />,
    );

    expect(screen.getByText(ALWAYS_CONFIRM_NOTE)).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.queryByLabelText('Approve options')).not.toBeInTheDocument();
    expect(submitApproval).not.toHaveBeenCalled();
  });

  it('gives mail writes NO per-item toggles (heterogeneous writes stay whole)', () => {
    render(
      <ApprovalConsentCard
        request={mailApproval('mail_create_draft', {
          to: ['ana@contoso.com'],
          subject: 'Hi',
          body: 'Body',
        })}
        messageIndex={1}
      />,
    );

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('falls back to the generic rendering when mail arguments are unparseable', () => {
    render(
      <ApprovalConsentCard
        request={normalApproval({
          server_id: M365_BUILTIN_SERVER_ID,
          server_label: 'Microsoft 365',
          tool_name: 'mail_create_draft',
          tool_arguments: 'not json at all',
        })}
        messageIndex={1}
      />,
    );

    // Raw arguments stay visible — nothing silently hidden.
    expect(screen.getByText('mail_create_draft')).toBeInTheDocument();
    expect(screen.getByText(/not json at all/)).toBeInTheDocument();
  });
});

const BATCH_HINT =
  'Uncheck items you don’t want — only checked items are created.';
const ALL_UNCHECKED_NOTE =
  'Nothing selected — approving would create nothing. Deny instead if you want none.';

const TASKS = [
  'Send the recap to Ana',
  'Book the follow-up room',
  'Update the budget sheet',
  'Ping Finance about Q3',
];

/** A first-party `tasks_create` batch (the only batched write in v1). */
function tasksApproval(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return normalApproval({
    server_id: M365_BUILTIN_SERVER_ID,
    server_label: 'Microsoft 365',
    tool_name: 'tasks_create',
    tool_arguments: JSON.stringify({
      tasks: TASKS,
      listName: 'Meeting follow-ups',
    }),
    ...overrides,
  });
}

describe('ApprovalConsentCard — tasks_create batch toggles', () => {
  const submitApproval = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    submitApproval.mockClear();
    useChatStore.setState({
      submittedApprovals: new Map(),
      submittingApprovals: new Set(),
      failedApprovals: new Set(),
      isStreaming: false,
      submitApproval,
    });
    useConversationStore.setState({
      conversations: [CONVERSATION],
      selectedConversationId: CONVERSATION.id,
    });
    useSettingsStore.setState({ toolApprovalRules: [] });
  });

  it('renders one checkbox per task, all checked, with the list name and hint', () => {
    render(<ApprovalConsentCard request={tasksApproval()} messageIndex={1} />);

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(TASKS.length);
    expect(boxes.every((box) => box.checked)).toBe(true);
    for (const task of TASKS) {
      expect(screen.getByText(task)).toBeInTheDocument();
    }
    expect(screen.getByText('List: Meeting follow-ups')).toBeInTheDocument();
    expect(screen.getByText(BATCH_HINT)).toBeInTheDocument();
  });

  it('approving with two items unchecked submits exactly the checked tasks, in order', () => {
    render(<ApprovalConsentCard request={tasksApproval()} messageIndex={1} />);

    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[2]);
    fireEvent.click(screen.getByText('Approve'));

    expect(submitApproval).toHaveBeenCalledTimes(1);
    const modified = submitApproval.mock.calls[0][5] as string;
    expect(JSON.parse(modified)).toEqual({
      tasks: [TASKS[0], TASKS[3]],
      listName: 'Meeting follow-ups',
    });
  });

  it('dims/strikes unchecked items so the card shows what will be created', () => {
    render(<ApprovalConsentCard request={tasksApproval()} messageIndex={1} />);

    fireEvent.click(screen.getAllByRole('checkbox')[1]);

    expect(screen.getByText(TASKS[1]).className).toContain('line-through');
    expect(screen.getByText(TASKS[0]).className).not.toContain('line-through');
  });

  it('sends NO modified arguments when every item stays checked', () => {
    render(<ApprovalConsentCard request={tasksApproval()} messageIndex={1} />);

    fireEvent.click(screen.getByText('Approve'));

    expect(submitApproval).toHaveBeenCalledTimes(1);
    expect(submitApproval.mock.calls[0][5]).toBeUndefined();
  });

  it('disables approve (but not deny) when every item is unchecked', () => {
    render(<ApprovalConsentCard request={tasksApproval()} messageIndex={1} />);

    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);

    const approve = screen.getByText('Approve').closest('button')!;
    expect(approve).toBeDisabled();
    expect(screen.getByText(ALL_UNCHECKED_NOTE)).toBeInTheDocument();

    // Deny stays live — unchecking everything is not a way to cancel.
    const deny = screen.getByText('Deny').closest('button')!;
    expect(deny).not.toBeDisabled();
    fireEvent.click(deny);
    expect(submitApproval).toHaveBeenCalledTimes(1);
    expect(submitApproval.mock.calls[0][1]).toBe(false);
  });

  it('gives a NON-builtin tasks-like tool no toggles at all', () => {
    render(
      <ApprovalConsentCard
        request={normalApproval({
          server_id: 'srv-1',
          server_label: 'Other MCP',
          tool_name: 'tasks_create',
          tool_arguments: JSON.stringify({ tasks: TASKS }),
        })}
        messageIndex={1}
      />,
    );

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByText(BATCH_HINT)).not.toBeInTheDocument();
    // Generic JSON rendering instead.
    expect(screen.getByText('tasks_create')).toBeInTheDocument();
  });

  it('falls back to the generic rendering when a task entry is not a string', () => {
    render(
      <ApprovalConsentCard
        request={tasksApproval({
          tool_arguments: JSON.stringify({ tasks: ['ok', { title: 'weird' }] }),
        })}
        messageIndex={1}
      />,
    );

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText('tasks_create')).toBeInTheDocument();
  });

  it('regression: batch cards keep always-confirm semantics (no approve-scope menu)', () => {
    render(<ApprovalConsentCard request={tasksApproval()} messageIndex={1} />);

    expect(screen.getByText(ALWAYS_CONFIRM_NOTE)).toBeInTheDocument();
    expect(screen.queryByLabelText('Approve options')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Always approve this tool'),
    ).not.toBeInTheDocument();
    expect(submitApproval).not.toHaveBeenCalled();
  });
});

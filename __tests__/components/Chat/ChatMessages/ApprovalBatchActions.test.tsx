import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ConsentRequest, Conversation } from '@/types/chat';

import { ApprovalBatchActions } from '@/components/Chat/ChatMessages/ApprovalBatchActions';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function nativeApproval(id: string): ConsentRequest {
  return {
    kind: 'approval',
    approval_request_id: id,
    server_id: 'srv-1',
    server_label: 'GitHub',
    tool_name: `tool_${id}`,
    tool_arguments: '{}',
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

describe('ApprovalBatchActions', () => {
  const submitApproval = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    submitApproval.mockClear();
    useChatStore.setState({
      submittedApprovals: new Map(),
      submittingApprovals: new Set(),
      isStreaming: false,
      submitApproval,
    });
    useConversationStore.setState({
      conversations: [CONVERSATION],
      selectedConversationId: CONVERSATION.id,
    });
  });

  it('renders nothing for a single pending approval — its card is the batch', () => {
    const { container } = render(
      <ApprovalBatchActions
        requests={[nativeApproval('a')]}
        messageIndex={1}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for Foundry approvals (no server_id) — they do not batch', () => {
    const foundry = (id: string): ConsentRequest => ({
      kind: 'approval',
      approval_request_id: id,
      tool_name: `tool_${id}`,
    });
    const { container } = render(
      <ApprovalBatchActions
        requests={[foundry('a'), foundry('b')]}
        messageIndex={1}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('hides once decided requests bring the undecided count below two', () => {
    useChatStore.setState({
      submittedApprovals: new Map([['a', true]]),
    });
    const { container } = render(
      <ApprovalBatchActions
        requests={[nativeApproval('a'), nativeApproval('b')]}
        messageIndex={1}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('treats persisted outcomes as decided (reloaded conversations)', () => {
    const { container } = render(
      <ApprovalBatchActions
        requests={[nativeApproval('a'), nativeApproval('b')]}
        messageIndex={1}
        approvalOutcomes={{ a: false }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('Approve all submits every undecided approval in order', async () => {
    render(
      <ApprovalBatchActions
        requests={[
          nativeApproval('a'),
          nativeApproval('b'),
          nativeApproval('c'),
        ]}
        messageIndex={1}
      />,
    );

    expect(screen.getByText('3 tool requests pending')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Approve all'));

    await waitFor(() => expect(submitApproval).toHaveBeenCalledTimes(3));
    expect(submitApproval.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    for (const call of submitApproval.mock.calls) {
      expect(call[1]).toBe(true);
      expect(call[2]).toMatchObject({ id: 'conv-1' });
      expect(call[3]).toBe(1);
      expect(call[4]).toBe('manual');
    }
  });

  it('Approve all skips alwaysConfirm M365 writes; Deny all covers them', async () => {
    const alwaysConfirm: ConsentRequest = {
      ...nativeApproval('w'),
      server_id: 'builtin-m365',
      tool_name: 'tasks_create',
    };
    render(
      <ApprovalBatchActions
        requests={[nativeApproval('a'), alwaysConfirm, nativeApproval('b')]}
        messageIndex={1}
      />,
    );
    fireEvent.click(screen.getByText('Approve all'));
    await waitFor(() => expect(submitApproval).toHaveBeenCalledTimes(2));
    expect(submitApproval.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);

    submitApproval.mockClear();
    fireEvent.click(screen.getByText('Deny all'));
    await waitFor(() => expect(submitApproval).toHaveBeenCalledTimes(3));
  });

  it('hides Approve all entirely when every undecided call is alwaysConfirm', () => {
    const write = (id: string): ConsentRequest => ({
      ...nativeApproval(id),
      server_id: 'builtin-m365',
      tool_name: 'calendar_create_event',
    });
    render(
      <ApprovalBatchActions
        requests={[write('x'), write('y')]}
        messageIndex={1}
      />,
    );
    expect(screen.queryByText('Approve all')).not.toBeInTheDocument();
    expect(screen.getByText('Deny all')).toBeInTheDocument();
  });

  it('Deny all submits every undecided approval with approve=false', async () => {
    render(
      <ApprovalBatchActions
        requests={[nativeApproval('a'), nativeApproval('b')]}
        messageIndex={2}
      />,
    );

    fireEvent.click(screen.getByText('Deny all'));

    await waitFor(() => expect(submitApproval).toHaveBeenCalledTimes(2));
    for (const call of submitApproval.mock.calls) {
      expect(call[1]).toBe(false);
    }
  });

  it('skips already-decided requests when batching the rest', async () => {
    useChatStore.setState({
      submittedApprovals: new Map([['a', false]]),
    });
    render(
      <ApprovalBatchActions
        requests={[
          nativeApproval('a'),
          nativeApproval('b'),
          nativeApproval('c'),
        ]}
        messageIndex={1}
      />,
    );

    expect(screen.getByText('2 tool requests pending')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Approve all'));

    await waitFor(() => expect(submitApproval).toHaveBeenCalledTimes(2));
    expect(submitApproval.mock.calls.map((c) => c[0])).toEqual(['b', 'c']);
  });

  it('disables the buttons while a stream is in flight', () => {
    useChatStore.setState({ isStreaming: true });
    render(
      <ApprovalBatchActions
        requests={[nativeApproval('a'), nativeApproval('b')]}
        messageIndex={1}
      />,
    );

    expect(screen.getByText('Approve all').closest('button')).toBeDisabled();
    expect(screen.getByText('Deny all').closest('button')).toBeDisabled();
  });
});

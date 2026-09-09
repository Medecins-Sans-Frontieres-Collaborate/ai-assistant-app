import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import { FolderView } from '@/components/Folders/FolderView';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useUIStore } from '@/client/stores/uiStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startNewConversation = vi.fn();
vi.mock('@/client/hooks/conversation/useNewConversation', () => ({
  useNewConversation: () => startNewConversation,
}));

vi.mock('@/client/hooks/ui/useUI', () => ({
  useUI: () => ({ toggleChatbar: vi.fn() }),
}));

const conv = (
  id: string,
  name: string,
  folderId: string | null,
  updatedAt?: string,
) =>
  ({
    id,
    name,
    messages: [],
    model: { id: 'm', name: 'M' },
    prompt: '',
    temperature: 0.5,
    folderId,
    updatedAt,
  }) as any;

function seed() {
  useConversationStore.setState({
    conversations: [
      conv('c-old', 'Older chat', 'f1', '2026-01-01T00:00:00Z'),
      conv('c-new', 'Newer chat', 'f1', '2026-06-01T00:00:00Z'),
      conv('c-out', 'Elsewhere', null),
    ],
    selectedConversationId: 'c-out',
    folders: [
      { id: 'f1', name: 'Work', type: 'chat' },
      { id: 'f2', name: 'Archive', type: 'chat' },
    ],
    searchTerm: '',
    isLoaded: true,
  });
  useUIStore.setState({ openFolderId: 'f1' });
}

describe('FolderView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the folder’s chats, newest first', () => {
    render(<FolderView folderId="f1" />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Newer chat')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Older chat')).toBeInTheDocument();
    expect(screen.queryByText('Elsewhere')).toBeNull();
  });

  it('opens a chat and leaves the folder page', () => {
    render(<FolderView folderId="f1" />);
    fireEvent.click(screen.getByText('Older chat'));
    expect(useConversationStore.getState().selectedConversationId).toBe(
      'c-old',
    );
    expect(useUIStore.getState().openFolderId).toBeNull();
  });

  it('starts a new chat inside the folder', () => {
    render(<FolderView folderId="f1" />);
    fireEvent.click(
      screen.getAllByRole('button', { name: /folderView.newChat/ })[0],
    );
    expect(startNewConversation).toHaveBeenCalledWith('f1');
    expect(useUIStore.getState().openFolderId).toBeNull();
  });

  it('bulk-moves selected chats through the folder picker', () => {
    render(<FolderView folderId="f1" />);
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'folderView.selectAll' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /folderView.moveTo/ }));
    fireEvent.click(screen.getByRole('option', { name: /Archive/ }));

    const byId = Object.fromEntries(
      useConversationStore.getState().conversations.map((c) => [c.id, c]),
    );
    expect(byId['c-old'].folderId).toBe('f2');
    expect(byId['c-new'].folderId).toBe('f2');
    expect(byId['c-out'].folderId).toBeNull();
    // Still on the (now empty) folder page — no chat was opened.
    expect(useUIStore.getState().openFolderId).toBe('f1');
    expect(screen.getByText('folderView.emptyTitle')).toBeInTheDocument();
  });

  it('renames the folder inline', () => {
    render(<FolderView folderId="f1" />);
    fireEvent.click(screen.getByRole('button', { name: 'folderView.rename' }));
    const input = screen.getByRole('textbox', {
      name: 'folderView.renameLabel',
    });
    fireEvent.change(input, { target: { value: '  Work 2026 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(
      useConversationStore.getState().folders.find((f) => f.id === 'f1')?.name,
    ).toBe('Work 2026');
  });

  it('deletes the folder after confirmation, keeping the chats, and closes', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FolderView folderId="f1" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'folderView.deleteFolder' }),
    );

    const state = useConversationStore.getState();
    expect(state.folders.find((f) => f.id === 'f1')).toBeUndefined();
    expect(state.conversations).toHaveLength(3);
    expect(
      state.conversations.find((c) => c.id === 'c-old')?.folderId,
    ).toBeNull();
    expect(useUIStore.getState().openFolderId).toBeNull();
  });

  it('closes when the selected conversation changes elsewhere (e.g. ⌘K search)', () => {
    render(<FolderView folderId="f1" />);
    act(() => useConversationStore.getState().selectConversation('c-old'));
    expect(useUIStore.getState().openFolderId).toBeNull();
  });

  it('renders nothing and closes for an unknown folder', () => {
    useUIStore.setState({ openFolderId: 'missing' });
    const { container } = render(<FolderView folderId="missing" />);
    expect(container).toBeEmptyDOMElement();
    expect(useUIStore.getState().openFolderId).toBeNull();
  });
});

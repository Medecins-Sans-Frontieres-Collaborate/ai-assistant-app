import { render } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';

import { ConversationItem } from '@/components/Sidebar/ConversationItem';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const t = (key: string) => key;

function renderItem(conversation: Conversation) {
  return render(
    <ConversationItem
      conversation={conversation}
      isSelected={false}
      folders={[]}
      t={t}
      handleSelectConversation={vi.fn()}
      handleDeleteConversation={vi.fn()}
      handleMoveToFolder={vi.fn()}
      handleRenameConversation={vi.fn()}
      handleExportConversation={vi.fn()}
    />,
  );
}

const base = {
  id: 'conv-1',
  name: 'Field report',
  messages: [],
  folderId: null,
} as unknown as Conversation;

describe('ConversationItem workflow icon', () => {
  it('shows a type icon for workflow conversations', () => {
    const { container } = renderItem({
      ...base,
      conversationType: 'translation',
    });
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('shows no leading icon for normal conversations', () => {
    const { container } = renderItem(base);
    const nameSpan = container.querySelector('span.flex');
    expect(nameSpan?.querySelector('svg')).toBeFalsy();
  });
});

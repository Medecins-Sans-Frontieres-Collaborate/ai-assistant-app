'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { FC, useRef } from 'react';

import { Conversation } from '@/types/chat';
import { FolderInterface } from '@/types/folder';

import { ConversationItem } from './ConversationItem';

interface VirtualConversationListProps {
  conversations: Conversation[];
  selectedConversationId: string | null;
  handleSelectConversation: (id: string) => void;
  handleDeleteConversation: (id: string, e: React.MouseEvent) => void;
  handleMoveToFolder: (conversationId: string, folderId: string | null) => void;
  handleRenameConversation: (id: string, currentName: string) => void;
  handleExportConversation: (conversation: Conversation) => void;
  folders: FolderInterface[];
  t: (key: string) => string;
  /** Estimated row height in px. Real heights are measured at runtime. */
  rowHeight?: number;
  /** Off-screen rows kept mounted on each side. */
  overscan?: number;
}

/**
 * Virtualized scroller for a flat list of conversations. Renders only
 * visible rows + `overscan` so DOM node count is constant. Falls back to
 * plain mapping below VIRTUALIZE_THRESHOLD where virtualization overhead
 * isn't justified.
 */
const VIRTUALIZE_THRESHOLD = 40;

export const VirtualConversationList: FC<VirtualConversationListProps> = ({
  conversations,
  selectedConversationId,
  handleSelectConversation,
  handleDeleteConversation,
  handleMoveToFolder,
  handleRenameConversation,
  handleExportConversation,
  folders,
  t,
  rowHeight = 44,
  overscan = 5,
}) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const shouldVirtualize = conversations.length > VIRTUALIZE_THRESHOLD;

  // Disabling the lint: we don't pass virtualizer's imperative methods
  // into memoized children, so the React Compiler warning doesn't apply.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
    enabled: shouldVirtualize,
  });

  if (!shouldVirtualize) {
    return (
      <div role="list">
        {conversations.map((conversation) => (
          <div role="listitem" key={conversation.id}>
            <ConversationItem
              conversation={conversation}
              isSelected={selectedConversationId === conversation.id}
              handleSelectConversation={handleSelectConversation}
              handleDeleteConversation={handleDeleteConversation}
              handleMoveToFolder={handleMoveToFolder}
              handleRenameConversation={handleRenameConversation}
              handleExportConversation={handleExportConversation}
              folders={folders}
              t={t as any}
            />
          </div>
        ))}
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      ref={parentRef}
      // Constrained-height container so the list scrolls inside itself
      // instead of pushing the sidebar footer off-screen.
      className="overflow-y-auto"
      style={{ maxHeight: '60vh' }}
    >
      <div
        role="list"
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {items.map((virtualRow) => {
          const conversation = conversations[virtualRow.index];
          if (!conversation) return null;
          return (
            <div
              key={conversation.id}
              role="listitem"
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <ConversationItem
                conversation={conversation}
                isSelected={selectedConversationId === conversation.id}
                handleSelectConversation={handleSelectConversation}
                handleDeleteConversation={handleDeleteConversation}
                handleMoveToFolder={handleMoveToFolder}
                handleRenameConversation={handleRenameConversation}
                handleExportConversation={handleExportConversation}
                folders={folders}
                t={t as any}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

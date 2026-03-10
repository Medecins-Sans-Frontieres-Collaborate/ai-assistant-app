import { IconMessage, IconSearch } from '@tabler/icons-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Conversation } from '@/types/chat';

import Modal from '@/components/UI/Modal';

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  filteredConversations: Conversation[];
  selectConversation: (id: string) => void;
  t: (key: string) => string;
}

export const SearchModal: React.FC<SearchModalProps> = ({
  isOpen,
  onClose,
  searchTerm,
  setSearchTerm,
  filteredConversations,
  selectConversation,
  t,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  // Auto-scroll active item into view
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  });

  const handleSelectConversation = useCallback(
    (id: string) => {
      selectConversation(id);
      onClose();
      setSearchTerm('');
    },
    [selectConversation, onClose, setSearchTerm],
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchTerm(e.target.value);
      setActiveIndex(0);
    },
    [setSearchTerm],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const count = filteredConversations.length;
      if (count === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % count);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + count) % count);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSelectConversation(filteredConversations[activeIndex].id);
      }
    },
    [filteredConversations, activeIndex, handleSelectConversation],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        onClose();
        setSearchTerm('');
      }}
      className="z-[100]"
      closeWithButton={false}
      size="lg"
      contentClassName="-m-6"
    >
      <div className="flex items-center gap-3 px-6 py-4 border-b border-neutral-300 dark:border-neutral-700">
        <IconSearch
          size={20}
          className="text-neutral-500 dark:text-neutral-400"
        />
        <input
          type="text"
          placeholder={t('Search_ellipsis')}
          value={searchTerm}
          onChange={handleSearchChange}
          onKeyDown={handleKeyDown}
          autoFocus
          className="flex-1 bg-transparent text-neutral-900 dark:text-white placeholder-neutral-500 dark:placeholder-neutral-400 focus:outline-none"
        />
      </div>

      <div className="max-h-[60vh] overflow-y-auto">
        {filteredConversations.length === 0 && searchTerm && (
          <div className="p-8 text-center text-neutral-500 dark:text-neutral-400">
            {t('No conversations found')}
          </div>
        )}
        {filteredConversations.length > 0 && (
          <div className="py-2">
            {filteredConversations.map((conversation, index) => (
              <button
                key={conversation.id}
                ref={index === activeIndex ? activeItemRef : undefined}
                className={`w-full flex items-center gap-3 px-6 py-3 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors text-left ${
                  index === activeIndex
                    ? 'bg-neutral-100 dark:bg-neutral-800'
                    : ''
                }`}
                onClick={() => handleSelectConversation(conversation.id)}
              >
                <IconMessage
                  size={16}
                  className="text-neutral-600 dark:text-neutral-400 shrink-0"
                />
                <span className="flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100">
                  {conversation.name || t('New Conversation')}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
};

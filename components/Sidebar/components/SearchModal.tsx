import { IconMessage, IconSearch } from '@tabler/icons-react';
import React from 'react';

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
  const handleSelectConversation = (id: string) => {
    selectConversation(id);
    onClose();
    setSearchTerm('');
  };

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
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-300 dark:border-gray-700">
        <IconSearch size={20} className="text-gray-500 dark:text-gray-400" />
        <input
          type="text"
          placeholder={t('Search_ellipsis')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          autoFocus
          className="flex-1 bg-transparent text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-0"
        />
      </div>

      <div className="max-h-[60vh] overflow-y-auto">
        {filteredConversations.length === 0 && searchTerm && (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            {t('No conversations found')}
          </div>
        )}
        {filteredConversations.length > 0 && (
          <div className="py-2">
            {filteredConversations.map((conversation) => (
              <button
                key={conversation.id}
                className="w-full flex items-center gap-3 px-6 py-3 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
                onClick={() => handleSelectConversation(conversation.id)}
              >
                <IconMessage
                  size={16}
                  className="text-gray-600 dark:text-gray-400 shrink-0"
                />
                <span className="flex-1 truncate text-sm text-gray-900 dark:text-gray-100">
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

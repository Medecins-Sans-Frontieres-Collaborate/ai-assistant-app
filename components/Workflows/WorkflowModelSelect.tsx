'use client';

import { IconChevronDown } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { isWorkflowEligibleModel } from '@/lib/services/workflows/shared/workflowModels';

import { Conversation } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { ModelSelect } from '@/components/Chat/ModelSelect';
import {
  DeepSeekIcon,
  MetaIcon,
  MistralIcon,
  OpenAIIcon,
  XAIIcon,
} from '@/components/Icons/providers';
import { ClaudeIcon } from '@/components/Icons/providers/ClaudeIcon';

interface WorkflowModelSelectProps {
  conversation: Conversation;
}

/**
 * Model picker for workflow windows — the same picker chat uses, so the
 * two surfaces behave identically, narrowed to what a workflow can run.
 *
 * The narrowing is not cosmetic: workflow routes call Azure OpenAI chat
 * completions directly and `resolveWorkflowModelId` silently falls back to
 * the default for anything else, so an unfiltered picker would let the user
 * choose a model the server then quietly swaps. Agents can't run in a
 * workflow at all, hence no Agents tab. The pick is conversation-scoped:
 * choosing from a narrowed list shouldn't re-default every future chat.
 */
export function WorkflowModelSelect({
  conversation,
}: WorkflowModelSelectProps) {
  const t = useTranslations('workflows');
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  const modelName = conversation.model?.name;
  const provider =
    OpenAIModels[conversation.model?.id as OpenAIModelID]?.provider ||
    conversation.model?.provider;

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label={t('shell.model')}
        title={t('shell.model')}
        className="flex items-center rounded-md border border-transparent px-2 py-1 transition-colors hover:border-gray-300 hover:bg-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700"
      >
        {getProviderIcon(provider)}
        <span
          className="ms-2 max-w-[160px] truncate text-sm font-semibold text-gray-800 dark:text-blue-50"
          title={modelName}
        >
          {modelName || t('shell.model')}
        </span>
        <IconChevronDown
          size={14}
          className="ms-1.5 text-black opacity-60 dark:text-white"
        />
      </button>

      {isOpen && (
        <div
          className="animate-fade-in-fast fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setIsOpen(false)}
        >
          <div
            className="animate-modal-in mx-4 max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl dark:bg-surface-dark"
            onClick={(event) => event.stopPropagation()}
          >
            <ModelSelect
              onClose={() => setIsOpen(false)}
              modelFilter={isWorkflowEligibleModel}
              hideAgentsTab
              scopedToConversation
            />
          </div>
        </div>
      )}
    </>
  );
}

function getProviderIcon(provider?: string) {
  const iconProps = { className: 'w-4 h-4 flex-shrink-0' };
  switch (provider) {
    case 'openai':
      return <OpenAIIcon {...iconProps} />;
    case 'deepseek':
      return <DeepSeekIcon {...iconProps} />;
    case 'xai':
      return <XAIIcon {...iconProps} />;
    case 'meta':
      return <MetaIcon {...iconProps} />;
    case 'anthropic':
      return <ClaudeIcon {...iconProps} />;
    case 'mistral':
      return <MistralIcon {...iconProps} />;
    default:
      return null;
  }
}

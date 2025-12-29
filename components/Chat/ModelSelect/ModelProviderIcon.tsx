import React from 'react';

import {
  AzureAIIcon,
  AzureOpenAIIcon,
  ClaudeIcon,
  DeepSeekIcon,
  MetaIcon,
  OpenAIIcon,
  XAIIcon,
} from '@/components/Icons/providers';

interface ModelProviderIconProps {
  provider?: string;
  size?: 'sm' | 'lg';
}

/**
 * Provider icon component for models
 * Shows appropriate icon based on model provider
 */
export const ModelProviderIcon: React.FC<ModelProviderIconProps> = ({
  provider,
  size = 'sm',
}) => {
  const iconProps = {
    className:
      size === 'lg' ? 'w-6 h-6 flex-shrink-0' : 'w-4 h-4 flex-shrink-0',
  };

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
    default:
      return null;
  }
};

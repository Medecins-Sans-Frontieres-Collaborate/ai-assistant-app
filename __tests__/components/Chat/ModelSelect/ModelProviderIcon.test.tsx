import { render } from '@testing-library/react';

import { ModelProviderIcon } from '@/components/Chat/ModelSelect/ModelProviderIcon';

import { describe, expect, it } from 'vitest';

describe('ModelProviderIcon', () => {
  const KNOWN_PROVIDERS = [
    'openai',
    'deepseek',
    'xai',
    'meta',
    'anthropic',
    'mistral',
  ];

  it.each(KNOWN_PROVIDERS)('renders an icon for provider "%s"', (provider) => {
    const { container } = render(<ModelProviderIcon provider={provider} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders nothing for an unknown provider', () => {
    const { container } = render(<ModelProviderIcon provider="cohere" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders nothing when provider is undefined', () => {
    const { container } = render(<ModelProviderIcon />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

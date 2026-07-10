import { render } from '@testing-library/react';

import { FAMILY_ORDER } from '@/components/Chat/ModelSelect/ModelFamilyFilter';
import { ModelProviderIcon } from '@/components/Chat/ModelSelect/ModelProviderIcon';

import { describe, expect, it } from 'vitest';

describe('ModelProviderIcon', () => {
  // Derived from the provider union (via FAMILY_ORDER) so a newly added
  // provider is automatically required to have an icon here.
  it.each(FAMILY_ORDER)('renders an icon for provider "%s"', (provider) => {
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

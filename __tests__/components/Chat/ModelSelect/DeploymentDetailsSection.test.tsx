import { render, screen } from '@testing-library/react';
import React from 'react';

import { OpenAIModel } from '@/types/openai';

import { DeploymentDetailsSection } from '@/components/Chat/ModelSelect/DeploymentDetailsSection';

import { describe, expect, it } from 'vitest';

// Note: next-intl is mocked globally in vitest.setup.dom.ts

const byomModel: OpenAIModel = {
  id: 'byom-abc123-my-mistral',
  name: 'my-mistral',
  maxLength: 128000,
  tokenLimit: 16384,
  provider: 'mistral',
  deploymentName: 'my-mistral',
  isCustomSourceModel: true,
  modelSource:
    '/subscriptions/sub-42/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/team-acct',
  sourceLocation: 'swedencentral',
  deploymentModelVersion: '2503',
};

describe('DeploymentDetailsSection', () => {
  it('renders every provenance row when all values are present', () => {
    render(
      <DeploymentDetailsSection
        selectedModel={byomModel}
        sourceName="My Sandbox"
      />,
    );

    // Section title + the deployment-name row label share the word.
    expect(screen.getAllByText('Deployment')).toHaveLength(2);

    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('My Sandbox')).toBeInTheDocument();

    // Account name + subscription id parsed from the ARM path.
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('team-acct · sub-42')).toBeInTheDocument();

    // Raw Azure region string, not prettified.
    expect(screen.getByText('Location')).toBeInTheDocument();
    expect(screen.getByText('swedencentral')).toBeInTheDocument();

    expect(screen.getByText('my-mistral')).toBeInTheDocument();

    expect(screen.getByText('Model version')).toBeInTheDocument();
    expect(screen.getByText('2503')).toBeInTheDocument();

    // Publisher uses the human family label for known providers.
    expect(screen.getByText('Publisher')).toBeInTheDocument();
    expect(screen.getByText('Mistral AI')).toBeInTheDocument();
  });

  it('omits rows whose value is absent', () => {
    const partial: OpenAIModel = {
      ...byomModel,
      sourceLocation: undefined,
      deploymentModelVersion: undefined,
    };

    render(<DeploymentDetailsSection selectedModel={partial} />);

    // No sourceName prop → no Source row; missing runtime fields → no
    // Location / Model version rows.
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
    expect(screen.queryByText('Location')).not.toBeInTheDocument();
    expect(screen.queryByText('Model version')).not.toBeInTheDocument();

    // The rows that do have values remain.
    expect(screen.getByText('team-acct · sub-42')).toBeInTheDocument();
    expect(screen.getByText('my-mistral')).toBeInTheDocument();
  });

  it('renders nothing at all when no row has a value', () => {
    const bare: OpenAIModel = {
      id: 'byom-abc123-bare',
      name: 'bare',
      maxLength: 1,
      tokenLimit: 1,
      isCustomSourceModel: true,
    };

    const { container } = render(
      <DeploymentDetailsSection selectedModel={bare} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('tolerates an unparseable ARM path by dropping only the account row', () => {
    const odd: OpenAIModel = { ...byomModel, modelSource: 'not-an-arm-path' };

    render(<DeploymentDetailsSection selectedModel={odd} />);

    expect(screen.queryByText('Account')).not.toBeInTheDocument();
    expect(screen.getByText('swedencentral')).toBeInTheDocument();
  });
});

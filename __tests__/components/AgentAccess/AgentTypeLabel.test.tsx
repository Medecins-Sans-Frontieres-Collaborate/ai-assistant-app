import { render, screen } from '@testing-library/react';
import React from 'react';

import { AgentTypeLabel } from '@/components/AgentAccess/AgentTypeLabel';

import { describe, expect, it } from 'vitest';

describe('AgentTypeLabel', () => {
  it('distinguishes external Foundry from native prompt agents without success colors', () => {
    const { container, rerender } = render(<AgentTypeLabel kind="foundry" />);
    expect(screen.getByText('Foundry')).toBeInTheDocument();
    expect(container.querySelector('.tabler-icon-cloud')).not.toBeNull();
    rerender(<AgentTypeLabel kind="prompt" />);
    expect(screen.getByText('Native · Prompt agent')).toBeInTheDocument();
    expect(container.querySelector('.tabler-icon-robot')).not.toBeNull();
  });

  it('uses the same Files category/icon for different file-source labels', () => {
    const { container, rerender } = render(
      <AgentTypeLabel kind="files" sourceLabel="Microsoft 365" />,
    );
    expect(
      screen.getByText('Native · Files · Microsoft 365'),
    ).toBeInTheDocument();
    expect(container.querySelector('.tabler-icon-files')).not.toBeNull();
    rerender(<AgentTypeLabel kind="files" sourceLabel="Uploaded files" />);
    expect(
      screen.getByText('Native · Files · Uploaded files'),
    ).toBeInTheDocument();
    expect(container.querySelector('.tabler-icon-files')).not.toBeNull();
  });
});

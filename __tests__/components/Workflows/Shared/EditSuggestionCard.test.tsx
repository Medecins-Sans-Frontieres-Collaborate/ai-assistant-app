import { render, screen } from '@testing-library/react';
import React from 'react';

import { ReviewEdit } from '@/types/workflow';

import { EditSuggestionCard } from '@/components/Workflows/Shared/Review/EditSuggestionCard';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const edit: ReviewEdit = {
  id: 'e1',
  criterion: 'consistency',
  before: 'M',
  after: 'Male',
  reason: 'Categorical variant',
  severity: 'minor',
  status: 'pending',
};

describe('EditSuggestionCard locationLabel', () => {
  it('renders the location line when provided', () => {
    render(
      <EditSuggestionCard
        edit={edit}
        resolveCriterionLabel={(id) => id}
        i18nNamespace="workflows.data"
        locationLabel="row 3f · Sex"
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText('row 3f · Sex')).toBeInTheDocument();
    expect(screen.getByText('Categorical variant')).toBeInTheDocument();
  });

  it('renders nothing extra without a location', () => {
    render(
      <EditSuggestionCard
        edit={edit}
        resolveCriterionLabel={(id) => id}
        i18nNamespace="workflows.data"
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByText(/row 3f/)).not.toBeInTheDocument();
  });
});

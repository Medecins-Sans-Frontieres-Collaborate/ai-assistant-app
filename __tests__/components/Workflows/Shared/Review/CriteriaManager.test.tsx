import { fireEvent, render, screen } from '@testing-library/react';

import { CustomCriterion } from '@/types/workflow';

import { CriteriaManager } from '@/components/Workflows/Shared/Review/CriteriaManager';

import { describe, expect, it, vi } from 'vitest';

// next-intl is mocked globally (vitest.setup.dom.ts) with no `workflows`
// namespace, so labels fall back to the bare key.
const NAME_LABEL = 'criterionName';
const RUBRIC_LABEL = 'criterionRubric';
const DELETE_LABEL = 'deleteCriterion';

const CRITERIA: CustomCriterion[] = [
  {
    id: 'custom:a',
    name: 'House style',
    rubric: 'Use the imperative',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  },
  {
    id: 'custom:b',
    name: 'Client terms',
    rubric: 'Follow the client glossary',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  },
];

function setup(criteria: CustomCriterion[] = CRITERIA) {
  const handlers = {
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };
  const utils = render(
    <CriteriaManager
      criteria={criteria}
      i18nNamespace="workflows.translation"
      {...handlers}
    />,
  );
  return { ...utils, ...handlers };
}

describe('CriteriaManager', () => {
  it('lists every criterion and opens the first one for editing', () => {
    setup();
    expect(screen.getByText('Client terms')).toBeTruthy();
    expect(screen.getByLabelText(NAME_LABEL)).toHaveValue('House style');
    expect(screen.getByLabelText(RUBRIC_LABEL)).toHaveValue(
      'Use the imperative',
    );
  });

  it('shows the empty state when there is nothing to edit', () => {
    const { container } = setup([]);
    expect(container.querySelector('input')).toBeNull();
    expect(screen.queryByLabelText(RUBRIC_LABEL)).toBeNull();
  });

  it('switches the detail pane when another criterion is picked', () => {
    setup();
    fireEvent.click(screen.getByText('Client terms'));
    expect(screen.getByLabelText(NAME_LABEL)).toHaveValue('Client terms');
  });

  it('saves the name on every keystroke, with no save button', () => {
    const { onUpdate } = setup();
    fireEvent.change(screen.getByLabelText(NAME_LABEL), {
      target: { value: 'House voice' },
    });
    expect(onUpdate).toHaveBeenCalledWith('custom:a', { name: 'House voice' });
  });

  it('saves the rubric the same way', () => {
    const { onUpdate } = setup();
    fireEvent.change(screen.getByLabelText(RUBRIC_LABEL), {
      target: { value: 'Never use the infinitive' },
    });
    expect(onUpdate).toHaveBeenCalledWith('custom:a', {
      rubric: 'Never use the infinitive',
    });
  });

  it('mints a namespaced id when creating, so built-ins cannot collide', () => {
    const { onCreate } = setup();
    fireEvent.click(screen.getByText('newCriterion'));

    const created = onCreate.mock.calls[0][0] as CustomCriterion;
    expect(created.id.startsWith('custom:')).toBe(true);
    expect(created.rubric).toBe('');
    expect(created.createdAt).toBe(created.updatedAt);
  });

  it('deletes and clears the detail pane so it cannot edit a ghost', () => {
    const { onDelete } = setup();
    fireEvent.click(screen.getByLabelText(DELETE_LABEL));

    expect(onDelete).toHaveBeenCalledWith('custom:a');
    expect(screen.queryByLabelText(NAME_LABEL)).toBeNull();
  });

  it('closes', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByLabelText('closeCriteria'));
    expect(onClose).toHaveBeenCalled();
  });
});

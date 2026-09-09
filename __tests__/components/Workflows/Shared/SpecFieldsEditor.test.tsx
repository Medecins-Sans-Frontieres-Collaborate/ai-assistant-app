import { fireEvent, render, screen } from '@testing-library/react';

import { SpecFieldsEditor } from '@/components/Workflows/Shared/SpecFieldsEditor';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const value = {
  sections: [
    { heading: 'Summary', guidance: 'Brief', required: true },
    { heading: 'Details', required: false },
  ],
  generalGuidance: 'Keep it short.',
};

describe('SpecFieldsEditor', () => {
  it('emits the full next value when a section field changes', () => {
    const onChange = vi.fn();
    render(<SpecFieldsEditor value={value} onChange={onChange} />);

    fireEvent.change(screen.getByDisplayValue('Summary'), {
      target: { value: 'Executive summary' },
    });

    expect(onChange).toHaveBeenCalledWith({
      sections: [
        { heading: 'Executive summary', guidance: 'Brief', required: true },
        { heading: 'Details', required: false },
      ],
      generalGuidance: 'Keep it short.',
    });
  });

  it('adds and removes sections through onChange', () => {
    const onChange = vi.fn();
    render(<SpecFieldsEditor value={value} onChange={onChange} />);

    // The jsdom i18n mock has no workflows namespace, so labels render as
    // their raw keys.
    fireEvent.click(screen.getByText('addSection'));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sections: [...value.sections, { heading: '', required: true }],
      }),
    );

    fireEvent.click(screen.getAllByLabelText('removeSection')[0]);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sections: [{ heading: 'Details', required: false }],
      }),
    );
  });

  it('edits generalGuidance and toggles required', () => {
    const onChange = vi.fn();
    render(<SpecFieldsEditor value={value} onChange={onChange} />);

    fireEvent.change(screen.getByDisplayValue('Keep it short.'), {
      target: { value: 'Be brief.' },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ generalGuidance: 'Be brief.' }),
    );

    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sections: [value.sections[0], { heading: 'Details', required: true }],
      }),
    );
  });
});

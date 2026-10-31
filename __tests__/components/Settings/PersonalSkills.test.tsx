import { fireEvent, render, screen } from '@testing-library/react';

import { PersonalSkills } from '@/components/Settings/PersonalSkills';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('personal skills editor', () => {
  beforeEach(() => useSettingsStore.setState({ userSkills: [] }));
  const enter = () => {
    fireEvent.click(screen.getByRole('button', { name: /newSkill/ }));
    fireEvent.change(screen.getByLabelText(/idLabel/), {
      target: { value: 'report' },
    });
    fireEvent.change(screen.getByLabelText(/nameLabel/), {
      target: { value: 'Report' },
    });
    fireEvent.change(screen.getByLabelText(/descriptionLabel/), {
      target: { value: 'Weekly report' },
    });
    fireEvent.change(screen.getByLabelText(/instructionsLabel/), {
      target: { value: 'Use progress, blockers and next steps.' },
    });
  };
  it('saves and edits a browser-local skill', () => {
    render(<PersonalSkills />);
    enter();
    fireEvent.click(screen.getByRole('button', { name: /^save$/ }));
    expect(useSettingsStore.getState().userSkills[0].id).toBe('report');
    fireEvent.click(screen.getByRole('button', { name: /^edit$/ }));
    expect(screen.getByLabelText(/idLabel/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/instructionsLabel/), {
      target: { value: 'Updated preferences' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/ }));
    expect(useSettingsStore.getState().userSkills[0].instructions).toBe(
      'Updated preferences',
    );
  });
  it('imports into the review editor without saving automatically', () => {
    render(<PersonalSkills />);
    fireEvent.click(screen.getByRole('button', { name: /^importSkill$/ }));
    fireEvent.change(screen.getByLabelText(/importTitle/), {
      target: {
        value:
          '---\nname: imported\ndescription: Imported test\n---\nRead me before saving.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /importParse/ }));
    expect(screen.getByLabelText(/instructionsLabel/)).toHaveValue(
      'Read me before saving.',
    );
    expect(useSettingsStore.getState().userSkills).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /^save$/ }));
    expect(useSettingsStore.getState().userSkills[0].id).toBe('imported');
  });
  it('does not overwrite a duplicate id and requires confirmation for deletion', () => {
    useSettingsStore.setState({
      userSkills: [
        {
          id: 'report',
          name: 'Existing',
          description: 'd',
          instructions: 'i',
          activation: 'auto',
          enabled: true,
        },
      ],
    });
    render(<PersonalSkills />);
    enter();
    fireEvent.click(screen.getByRole('button', { name: /^save$/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(/duplicate/);
    expect(useSettingsStore.getState().userSkills[0].name).toBe('Existing');
    vi.spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/ }));
    expect(useSettingsStore.getState().userSkills).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/ }));
    expect(useSettingsStore.getState().userSkills).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

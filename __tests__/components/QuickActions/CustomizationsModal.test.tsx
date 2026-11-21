import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { CustomizationsModal } from '@/components/QuickActions/CustomizationsModal';
import { NESTED_DIALOG_ATTRIBUTE } from '@/components/UI/DashboardModal';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// The tabs' contents are not under test: only the frame around them.
vi.mock('@/components/QuickActions/PromptsTab', () => ({
  PromptsTab: () => <div data-testid="prompts-tab" />,
}));
vi.mock('@/components/QuickActions/TonesTab', () => ({
  TonesTab: () => null,
}));
vi.mock('@/components/QuickActions/StructuresTab', () => ({
  StructuresTab: () => null,
}));
vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({ prompts: [] }),
}));
vi.mock('@/client/hooks/settings/useTones', () => ({
  useTones: () => ({ tones: [] }),
}));
vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({ folders: [] }),
}));
vi.mock('@/client/hooks/useStructuresEnabled', () => ({
  useStructuresEnabled: () => false,
}));

/** Quick Actions as a dialog: named, closable by its button and by Escape. */
describe('CustomizationsModal', () => {
  const open = () => {
    const onClose = vi.fn();
    render(<CustomizationsModal isOpen onClose={onClose} />);
    return onClose;
  };

  it('is a modal dialog named by its title', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Quick Actions' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('has a close button with a name', () => {
    const onClose = open();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes with Escape', () => {
    const onClose = open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to an editor open over it, so its work is not lost', () => {
    const onClose = open();
    const editor = document.createElement('div');
    editor.setAttribute(NESTED_DIALOG_ATTRIBUTE, '');
    document.body.appendChild(editor);
    fireEvent.keyDown(window, { key: 'Escape' });
    editor.remove();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores an Escape something else already handled', () => {
    const onClose = open();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
  });
});

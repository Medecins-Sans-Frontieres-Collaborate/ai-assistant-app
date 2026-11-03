import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { AgentActionsMenu } from '@/components/AgentAccess/AgentActionsMenu';

import { describe, expect, it, vi } from 'vitest';

describe('AgentActionsMenu', () => {
  it('reveals secondary actions on demand, skips disabled actions, and restores focus', () => {
    render(
      <AgentActionsMenu name="Handbook">
        <button>Hide</button>
        <button disabled>Refresh</button>
        <button>Delete</button>
      </AgentActionsMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'More: Handbook' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const first = screen.getByRole('menuitem', { name: 'Hide' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const last = screen.getByRole('menuitem', { name: 'Delete' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Home' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'End' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('runs the selected action once, closes, and retains the caller confirmation flow', () => {
    const onDelete = vi.fn();
    render(
      <AgentActionsMenu name="Handbook">
        <button onClick={onDelete}>Delete</button>
      </AgentActionsMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'More: Handbook' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

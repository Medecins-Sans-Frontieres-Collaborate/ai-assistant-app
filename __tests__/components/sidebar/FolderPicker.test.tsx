import { render, screen } from '@testing-library/react';
import React, { useRef } from 'react';

import { FolderInterface } from '@/types/folder';

import {
  FOLDER_PICKER_SEARCH_THRESHOLD,
  FolderPicker,
} from '@/components/Sidebar/FolderPicker';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

function folder(id: string, name: string): FolderInterface {
  return { id, name, type: 'chat' };
}

function Harness({
  folders,
  hideClearOption = false,
  onCreateFolder,
}: {
  folders: FolderInterface[];
  hideClearOption?: boolean;
  onCreateFolder?: (name: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef}>trigger</button>
      <FolderPicker
        triggerRef={triggerRef}
        isOpen
        onClose={() => {}}
        folders={folders}
        value={null}
        onSelect={vi.fn()}
        hideClearOption={hideClearOption}
        onCreateFolder={onCreateFolder}
      />
    </>
  );
}

describe('FolderPicker', () => {
  it('lists folders alphabetically with "No folder" pinned first', () => {
    render(
      <Harness
        folders={[
          folder('1', 'zeta'),
          folder('2', 'Alpha'),
          folder('3', 'mid'),
        ]}
      />,
    );
    const names = screen
      .getAllByRole('option')
      .map((el) => el.textContent?.trim());
    expect(names).toEqual(['No folder', 'Alpha', 'mid', 'zeta']);
  });

  it('can hide the "No folder" row', () => {
    render(<Harness folders={[folder('1', 'Only')]} hideClearOption />);
    expect(screen.queryByRole('option', { name: 'No folder' })).toBeNull();
  });

  it('shows the search box only once the list is long', () => {
    const few = Array.from(
      { length: FOLDER_PICKER_SEARCH_THRESHOLD - 1 },
      (_, i) => folder(String(i), `Folder ${i}`),
    );
    const { unmount } = render(<Harness folders={few} />);
    expect(
      screen.queryByPlaceholderText('folderPicker.searchPlaceholder'),
    ).toBeNull();
    unmount();

    const many = [...few, folder('x', 'Folder x')];
    render(<Harness folders={many} />);
    expect(
      screen.getByPlaceholderText('folderPicker.searchPlaceholder'),
    ).toBeInTheDocument();
  });
});

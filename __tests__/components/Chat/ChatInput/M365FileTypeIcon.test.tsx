import { render } from '@testing-library/react';

import type { M365DriveEntry } from '@/types/m365';

import M365FileTypeIcon from '@/components/Chat/ChatInput/M365FileTypeIcon';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

function entry(overrides: Partial<M365DriveEntry>): M365DriveEntry {
  return {
    driveId: 'd1',
    itemId: 'i1',
    name: 'file',
    isFolder: false,
    ...overrides,
  };
}

function iconClasses(target: M365DriveEntry): DOMTokenList {
  const { container } = render(<M365FileTypeIcon entry={target} />);
  const svg = container.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg!.classList;
}

describe('M365FileTypeIcon', () => {
  it('renders folders with the amber folder icon', () => {
    const classes = iconClasses(entry({ name: 'Reports', isFolder: true }));
    expect(classes.contains('text-amber-500')).toBe(true);
  });

  it('maps office extensions to their accent colors', () => {
    expect(
      iconClasses(entry({ name: 'deck.pptx' })).contains('text-orange-500'),
    ).toBe(true);
    expect(
      iconClasses(entry({ name: 'notes.PDF' })).contains('text-red-500'),
    ).toBe(true);
    expect(
      iconClasses(entry({ name: 'plan.docx' })).contains('text-blue-600'),
    ).toBe(true);
    expect(
      iconClasses(entry({ name: 'data.xlsx' })).contains('text-green-600'),
    ).toBe(true);
  });

  it('falls back to the mimeType prefix when the extension is unknown', () => {
    const classes = iconClasses(
      entry({ name: 'snapshot.raw', mimeType: 'image/x-raw' }),
    );
    expect(classes.contains('text-purple-500')).toBe(true);
  });

  it('prefers the extension over the mimeType', () => {
    const classes = iconClasses(
      entry({ name: 'movie.mp4', mimeType: 'application/octet-stream' }),
    );
    expect(classes.contains('text-purple-500')).toBe(true);
  });

  it('uses the generic file icon for unknown types', () => {
    const classes = iconClasses(entry({ name: 'mystery.xyz' }));
    expect(classes.contains('text-gray-400')).toBe(true);
  });
});

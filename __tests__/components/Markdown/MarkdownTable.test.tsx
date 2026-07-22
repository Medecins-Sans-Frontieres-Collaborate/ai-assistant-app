import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { MarkdownTable } from '@/components/Markdown/MarkdownTable';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { toastMock, downloadFileMock, exportToDOCXMock } = vi.hoisted(() => ({
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn().mockReturnValue('toast-id'),
    dismiss: vi.fn(),
  },
  downloadFileMock: vi.fn(),
  exportToDOCXMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('react-hot-toast', () => ({
  default: toastMock,
}));

vi.mock('@/lib/utils/shared/document/exportUtils', () => ({
  downloadFile: downloadFileMock,
  exportToPDF: vi.fn(),
  exportToDOCX: exportToDOCXMock,
  htmlToPlainText: vi.fn(),
  htmlToMarkdown: vi.fn(),
  sanitizeHtmlForExport: vi.fn(),
}));

// Avoid pulling the full streamdown bundle into the test; the component only
// reads `isAnimating` from the context.
vi.mock('streamdown', () => ({
  StreamdownContext: React.createContext({ isAnimating: false }),
}));

const writeTextMock = vi.fn().mockResolvedValue(undefined);

function renderTable() {
  return render(
    <MarkdownTable>
      <thead>
        <tr>
          <th>Name</th>
          <th>Age</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Ada</td>
          <td>36</td>
        </tr>
      </tbody>
    </MarkdownTable>,
  );
}

describe('MarkdownTable', () => {
  beforeEach(() => {
    downloadFileMock.mockClear();
    exportToDOCXMock.mockClear();
    exportToDOCXMock.mockResolvedValue(undefined);
    toastMock.success.mockClear();
    toastMock.error.mockClear();
    writeTextMock.mockClear();
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });
  });

  it('renders the table content with copy and download triggers', () => {
    renderTable();

    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy table' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Download table' }),
    ).toBeInTheDocument();
  });

  it('offers CSV, Markdown, and Word download formats', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Download table' }));

    expect(screen.getByText('CSV (.csv)')).toBeInTheDocument();
    expect(screen.getByText('Markdown (.md)')).toBeInTheDocument();
    expect(screen.getByText('Word (.docx)')).toBeInTheDocument();
  });

  it('downloads the table as CSV with a UTF-8 BOM', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Download table' }));
    fireEvent.click(screen.getByText('CSV (.csv)'));

    expect(downloadFileMock).toHaveBeenCalledWith(
      '\u{FEFF}Name,Age\r\nAda,36',
      'table.csv',
      'text/csv;charset=utf-8',
    );
    expect(toastMock.success).toHaveBeenCalledWith('Exported as CSV');
  });

  it('downloads the table as a GFM markdown file', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Download table' }));
    fireEvent.click(screen.getByText('Markdown (.md)'));

    expect(downloadFileMock).toHaveBeenCalledWith(
      '| Name | Age |\n| --- | --- |\n| Ada | 36 |',
      'table.md',
      'text/markdown',
    );
  });

  it('downloads the table as DOCX via the server export pipeline', async () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Download table' }));
    fireEvent.click(screen.getByText('Word (.docx)'));

    await waitFor(() => {
      expect(exportToDOCXMock).toHaveBeenCalled();
    });
    const [html, fileName] = exportToDOCXMock.mock.calls[0];
    expect(fileName).toBe('table.docx');
    expect(html).toContain('>Ada</td>');
    expect(html).toContain('>Name</th>');
  });

  it('copies the table as markdown to the clipboard', async () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
    fireEvent.click(screen.getByText('Markdown'));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        '| Name | Age |\n| --- | --- |\n| Ada | 36 |',
      );
    });
  });

  it('copies the table as TSV to the clipboard', async () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
    fireEvent.click(screen.getByText('TSV'));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('Name\tAge\nAda\t36');
    });
  });

  it('shows an error toast when the clipboard write fails', async () => {
    writeTextMock.mockRejectedValueOnce(new Error('denied'));
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
    fireEvent.click(screen.getByText('CSV'));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Failed to copy table');
    });
  });
});

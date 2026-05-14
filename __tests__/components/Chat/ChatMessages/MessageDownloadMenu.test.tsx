import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { MessageDownloadMenu } from '@/components/Chat/ChatMessages/MessageDownloadMenu';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) => {
    const messages: Record<string, string> = {
      'chat.downloadResponse': 'Download response',
      'artifact.formatMarkdown': 'Markdown (.md)',
      'artifact.formatHtml': 'HTML (.html)',
      'artifact.formatDocx': 'Word (.docx)',
      'artifact.formatText': 'Plain Text (.txt)',
      'artifact.formatPdf': 'PDF (.pdf)',
      'artifact.exportedAsMarkdown': 'Exported as Markdown',
      'artifact.noContentToExport': 'No content to export',
    };
    let message = messages[key] || key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        message = message.replace(`{${k}}`, v);
      });
    }
    return message;
  },
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const downloadFileMock = vi.fn();
const exportToPDFMock = vi.fn().mockResolvedValue(undefined);
const exportToDOCXMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/utils/shared/document/exportUtils', () => ({
  downloadFile: (...args: unknown[]) => downloadFileMock(...args),
  exportToPDF: (...args: unknown[]) => exportToPDFMock(...args),
  exportToDOCX: (...args: unknown[]) => exportToDOCXMock(...args),
  htmlToMarkdown: (html: string) => html,
  htmlToPlainText: async (html: string) => html,
}));

const markdownToHtmlMock = vi.fn((md: string) => `<p>${md}</p>`);

vi.mock('@/lib/utils/shared/document/formatConverter', () => ({
  markdownToHtml: (md: string) => markdownToHtmlMock(md),
}));

describe('MessageDownloadMenu', () => {
  beforeEach(() => {
    downloadFileMock.mockClear();
    exportToPDFMock.mockClear();
    exportToDOCXMock.mockClear();
    markdownToHtmlMock.mockClear();
  });

  it('renders the download trigger with the download response label', () => {
    render(<MessageDownloadMenu content="hello" />);

    const trigger = screen.getByRole('button', { name: 'Download response' });
    expect(trigger).toBeInTheDocument();
    expect(trigger).not.toBeDisabled();
  });

  it('shows all five format options when the trigger is clicked', () => {
    render(<MessageDownloadMenu content="hello" />);

    fireEvent.click(screen.getByRole('button', { name: 'Download response' }));

    expect(screen.getByText('Markdown (.md)')).toBeInTheDocument();
    expect(screen.getByText('HTML (.html)')).toBeInTheDocument();
    expect(screen.getByText('Word (.docx)')).toBeInTheDocument();
    expect(screen.getByText('Plain Text (.txt)')).toBeInTheDocument();
    expect(screen.getByText('PDF (.pdf)')).toBeInTheDocument();
  });

  it('downloads markdown directly without converting to HTML first', () => {
    render(<MessageDownloadMenu content="# hi" fileName="response" />);

    fireEvent.click(screen.getByRole('button', { name: 'Download response' }));
    fireEvent.click(screen.getByText('Markdown (.md)'));

    expect(markdownToHtmlMock).not.toHaveBeenCalled();
    expect(downloadFileMock).toHaveBeenCalledWith(
      '# hi',
      'response.md',
      'text/markdown',
    );
  });

  it('converts markdown to HTML before exporting non-md formats', async () => {
    render(<MessageDownloadMenu content="# hi" />);

    fireEvent.click(screen.getByRole('button', { name: 'Download response' }));
    fireEvent.click(screen.getByText('Word (.docx)'));

    // Wait a microtask so the async export handler runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(markdownToHtmlMock).toHaveBeenCalledWith('# hi');
    expect(exportToDOCXMock).toHaveBeenCalledWith(
      '<p># hi</p>',
      'message.docx',
    );
  });

  it('does nothing when disabled', () => {
    render(
      <MessageDownloadMenu
        content="# hi"
        disabled
        disabledTitle="Disabled here"
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Download response' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', 'Disabled here');

    fireEvent.click(trigger);
    expect(screen.queryByText('Markdown (.md)')).not.toBeInTheDocument();
  });
});

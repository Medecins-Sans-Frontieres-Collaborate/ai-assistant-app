import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { MessageDownloadMenu } from '@/components/Chat/ChatMessages/MessageDownloadMenu';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  toastMock,
  downloadFileMock,
  exportToPDFMock,
  exportToDOCXMock,
  htmlToPlainTextMock,
  markdownToHtmlMock,
} = vi.hoisted(() => ({
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn().mockReturnValue('toast-id'),
    dismiss: vi.fn(),
  },
  downloadFileMock: vi.fn(),
  exportToPDFMock: vi.fn().mockResolvedValue(undefined),
  exportToDOCXMock: vi.fn().mockResolvedValue(undefined),
  htmlToPlainTextMock: vi.fn(async (html: string) => `plain:${html}`),
  markdownToHtmlMock: vi.fn((md: string) => `<p>${md}</p>`),
}));

vi.mock('react-hot-toast', () => ({
  default: toastMock,
}));

vi.mock('@/lib/utils/shared/document/exportUtils', () => ({
  downloadFile: (...args: unknown[]) => downloadFileMock(...args),
  exportToPDF: (...args: unknown[]) => exportToPDFMock(...args),
  exportToDOCX: (...args: unknown[]) => exportToDOCXMock(...args),
  htmlToPlainText: (html: string) => htmlToPlainTextMock(html),
}));

vi.mock('@/lib/utils/shared/document/formatConverter', () => ({
  markdownToHtml: (md: string) => markdownToHtmlMock(md),
}));

describe('MessageDownloadMenu', () => {
  beforeEach(() => {
    downloadFileMock.mockClear();
    exportToPDFMock.mockClear();
    exportToPDFMock.mockResolvedValue(undefined);
    exportToDOCXMock.mockClear();
    exportToDOCXMock.mockResolvedValue(undefined);
    markdownToHtmlMock.mockClear();
    htmlToPlainTextMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
    toastMock.loading.mockClear();
    toastMock.dismiss.mockClear();
  });

  function openMenu() {
    fireEvent.click(screen.getByRole('button', { name: 'Download response' }));
  }

  it('renders the download trigger with the download response label', () => {
    render(<MessageDownloadMenu content="hello" />);

    const trigger = screen.getByRole('button', { name: 'Download response' });
    expect(trigger).toBeInTheDocument();
    expect(trigger).not.toBeDisabled();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows all five format options when the trigger is clicked', () => {
    render(<MessageDownloadMenu content="hello" />);
    openMenu();

    expect(screen.getByText('Markdown (.md)')).toBeInTheDocument();
    expect(screen.getByText('HTML (.html)')).toBeInTheDocument();
    expect(screen.getByText('Word (.docx)')).toBeInTheDocument();
    expect(screen.getByText('Plain Text (.txt)')).toBeInTheDocument();
    expect(screen.getByText('PDF (.pdf)')).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: 'Download response' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('downloads markdown directly without converting to HTML first', () => {
    render(<MessageDownloadMenu content="# hi" fileName="response" />);
    openMenu();
    fireEvent.click(screen.getByText('Markdown (.md)'));

    expect(markdownToHtmlMock).not.toHaveBeenCalled();
    expect(downloadFileMock).toHaveBeenCalledWith(
      '# hi',
      'response.md',
      'text/markdown',
    );
  });

  it('exports HTML through the markdown→HTML pipeline', async () => {
    render(<MessageDownloadMenu content="# hi" fileName="response" />);
    openMenu();
    fireEvent.click(screen.getByText('HTML (.html)'));

    await waitFor(() => {
      expect(downloadFileMock).toHaveBeenCalledWith(
        '<p># hi</p>',
        'response.html',
        'text/html',
      );
    });
    expect(markdownToHtmlMock).toHaveBeenCalledWith('# hi');
  });

  it('exports plain text by stripping HTML', async () => {
    render(<MessageDownloadMenu content="# hi" fileName="response" />);
    openMenu();
    fireEvent.click(screen.getByText('Plain Text (.txt)'));

    await waitFor(() => {
      expect(downloadFileMock).toHaveBeenCalledWith(
        'plain:<p># hi</p>',
        'response.txt',
        'text/plain',
      );
    });
    expect(htmlToPlainTextMock).toHaveBeenCalledWith('<p># hi</p>');
  });

  it('exports DOCX via the server endpoint', async () => {
    render(<MessageDownloadMenu content="# hi" fileName="response" />);
    openMenu();
    fireEvent.click(screen.getByText('Word (.docx)'));

    await waitFor(() => {
      expect(exportToDOCXMock).toHaveBeenCalledWith(
        '<p># hi</p>',
        'response.docx',
      );
    });
    expect(markdownToHtmlMock).toHaveBeenCalledWith('# hi');
  });

  it('exports PDF and dismisses its loading toast on success', async () => {
    render(<MessageDownloadMenu content="# hi" fileName="response" />);
    openMenu();
    fireEvent.click(screen.getByText('PDF (.pdf)'));

    await waitFor(() => {
      expect(exportToPDFMock).toHaveBeenCalledWith(
        '<p># hi</p>',
        'response.pdf',
      );
    });
    expect(toastMock.loading).toHaveBeenCalledWith('Generating PDF...');
    expect(toastMock.dismiss).toHaveBeenCalledWith('toast-id');
    expect(toastMock.success).toHaveBeenCalledWith('Exported as PDF');
  });

  it('dismisses the loading toast even when PDF export rejects', async () => {
    exportToPDFMock.mockRejectedValueOnce(new Error('boom'));
    render(<MessageDownloadMenu content="# hi" fileName="response" />);
    openMenu();
    fireEvent.click(screen.getByText('PDF (.pdf)'));

    await waitFor(() => {
      expect(toastMock.dismiss).toHaveBeenCalledWith('toast-id');
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to export as PDF (.pdf)',
    );
  });

  it('shows an error toast when content is empty', () => {
    render(<MessageDownloadMenu content="" />);
    openMenu();
    fireEvent.click(screen.getByText('Markdown (.md)'));

    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('No content to export');
  });

  it('derives the filename from the response content when no fileName prop is passed', () => {
    render(
      <MessageDownloadMenu content="# Project status report\n\nDetails here." />,
    );
    openMenu();
    fireEvent.click(screen.getByText('Markdown (.md)'));

    const [, downloadedName] = downloadFileMock.mock.calls[0];
    expect(downloadedName).toMatch(/^Project status report/);
    expect(downloadedName).toMatch(/\.md$/);
  });

  it('falls back to "message" when content has no usable characters', () => {
    render(<MessageDownloadMenu content="   " />);
    openMenu();
    fireEvent.click(screen.getByText('Markdown (.md)'));

    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('No content to export');
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

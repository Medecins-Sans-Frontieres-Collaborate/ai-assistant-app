import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import type { ToolCallRecord } from '@/types/chat';

import { GeneratedFilesPanel } from '@/components/Chat/ChatMessages/GeneratedFilesPanel';

import { PAGE_PREVIEW_MAX_PAGES } from '@/lib/constants/filePreview';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const IMAGE_DATA_URL = 'data:image/png;base64,AAAA';

vi.mock('@/lib/services/imageService', () => ({
  fetchImageBase64FromMessageContent: vi.fn(async () => IMAGE_DATA_URL),
}));

const HASH = 'a'.repeat(64);

const generated = (filename: string, isImage = false) => ({
  url: `/api/file/${HASH}.${filename.split('.').pop()}`,
  filename,
  mime_type: isImage ? 'image/png' : 'application/octet-stream',
  is_image: isImage,
});

const callWith = (...files: ReturnType<typeof generated>[]): ToolCallRecord[] =>
  [
    {
      id: 'c1',
      name: 'code_interpreter',
      status: 'completed',
      generated_files: files,
    },
  ] as unknown as ToolCallRecord[];

/** A preview response with the given number of rendered pages. */
const previewResponse = (rendered: number, totalPages = rendered) => ({
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    data: { pages: Array(rendered).fill(IMAGE_DATA_URL), totalPages },
  }),
});

describe('GeneratedFilesPanel previews', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers a preview for documents and only a download for other files', () => {
    render(
      <GeneratedFilesPanel
        toolCalls={callWith(generated('deck.pptx'), generated('rows.csv'))}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Preview' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Download' })).toHaveLength(2);
  });

  it('shows the rendered pages of a presentation without downloading it', async () => {
    fetchMock.mockResolvedValue(previewResponse(3));
    render(
      <GeneratedFilesPanel toolCalls={callWith(generated('deck.pptx'))} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByAltText('Page 3 of 3')).toBeInTheDocument();
    expect(screen.getByAltText('Page 1 of 3')).toHaveAttribute(
      'src',
      IMAGE_DATA_URL,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/file/${HASH}.pptx/preview`);
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
  });

  it('says so when a long document is shown only in part', async () => {
    const total = PAGE_PREVIEW_MAX_PAGES + 5;
    fetchMock.mockResolvedValue(previewResponse(PAGE_PREVIEW_MAX_PAGES, total));
    render(
      <GeneratedFilesPanel toolCalls={callWith(generated('report.docx'))} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(
      await screen.findByText(
        `Showing the first ${PAGE_PREVIEW_MAX_PAGES} of ${total} pages. Download the file to see the rest.`,
      ),
    ).toBeInTheDocument();
  });

  it('explains a failed preview and keeps the download available', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ success: false }),
    });
    render(
      <GeneratedFilesPanel toolCalls={callWith(generated('report.docx'))} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file could not be previewed. You can still download it.',
    );
    expect(
      screen.getAllByRole('link', { name: 'Download' }).length,
    ).toBeGreaterThan(0);
  });

  it('enlarges a generated image from what is already loaded', async () => {
    render(
      <GeneratedFilesPanel
        toolCalls={callWith(generated('chart.png', true))}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'Enlarge chart.png' }),
    );

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getAllByAltText('chart.png')).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes the viewer', async () => {
    fetchMock.mockResolvedValue(previewResponse(1));
    render(
      <GeneratedFilesPanel toolCalls={callWith(generated('deck.pptx'))} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByAltText('Page 1 of 1');

    fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

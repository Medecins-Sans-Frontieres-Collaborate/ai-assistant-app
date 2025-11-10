import { NextRequest, NextResponse } from 'next/server';

import HTMLtoDOCX from 'html-to-docx';

/**
 * POST /api/export/docx
 * Converts HTML to DOCX on the server-side
 */
export async function POST(request: NextRequest) {
  try {
    const { html } = await request.json();

    if (!html || typeof html !== 'string') {
      return NextResponse.json(
        { error: 'Invalid HTML content' },
        { status: 400 },
      );
    }

    // Convert HTML to DOCX
    const docxBlob = await HTMLtoDOCX(html, null, {
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true,
    });

    // Return DOCX file as response
    return new NextResponse(docxBlob, {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="document.docx"',
      },
    });
  } catch (error) {
    console.error('Error converting HTML to DOCX:', error);
    return NextResponse.json(
      { error: 'Failed to convert to DOCX' },
      { status: 500 },
    );
  }
}

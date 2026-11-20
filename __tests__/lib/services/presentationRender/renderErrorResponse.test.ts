import { DocumentSignatureError } from '@/lib/services/presentationRender/libreOfficeInputs';
import {
  LibreOfficeFailedError,
  LibreOfficeMemoryError,
  LibreOfficeTimeoutError,
} from '@/lib/services/presentationRender/libreOfficeProcess';
import {
  RENDER_RETRY_AFTER_SECONDS,
  renderErrorResponse,
} from '@/lib/services/presentationRender/renderErrorResponse';
import { RenderBusyError } from '@/lib/services/presentationRender/renderQueue';

import { describe, expect, it } from 'vitest';

/** One answer per render-service cause, the same in every route. */
describe('renderErrorResponse', () => {
  it('answers a full queue with 503 and when to try again', async () => {
    const response = renderErrorResponse(new RenderBusyError(200))!;
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe(
      String(RENDER_RETRY_AFTER_SECONDS),
    );
    expect(await response.json()).toMatchObject({ code: 'RENDER_BUSY' });
  });

  it('answers a protected or unreadable file with 422 and its reason', async () => {
    const locked = renderErrorResponse(
      new DocumentSignatureError('pptx', 'cfb'),
    )!;
    expect(locked.status).toBe(422);
    expect(await locked.json()).toMatchObject({ code: 'DOCUMENT_PROTECTED' });
    const junk = renderErrorResponse(
      new DocumentSignatureError('pptx', 'unknown'),
    )!;
    expect(await junk.json()).toMatchObject({ code: 'DOCUMENT_UNREADABLE' });
  });

  it('answers limits: memory 422, time 504', () => {
    expect(renderErrorResponse(new LibreOfficeMemoryError(2048))!.status).toBe(
      422,
    );
    expect(
      renderErrorResponse(new LibreOfficeTimeoutError(60_000))!.status,
    ).toBe(504);
  });

  it('leaves every other error to the route', () => {
    expect(renderErrorResponse(new Error('blob download failed'))).toBeNull();
    expect(
      renderErrorResponse(new LibreOfficeFailedError('x', false, '')),
    ).toBeNull();
  });
});

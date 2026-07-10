import { DocumentTranslationService } from '@/lib/services/documentTranslation/documentTranslationService';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(),
  getBearerTokenProvider: () => async () => 'mock-bearer-token',
}));

const OPERATION_ID = '11111111-2222-3333-4444-555555555555';

describe('DocumentTranslationService (batch)', () => {
  let service: DocumentTranslationService;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.com';
    service = new DocumentTranslationService();
  });

  describe('submitBatchTranslation', () => {
    it('POSTs a storageType File batch and returns the operation id', async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(null, {
            status: 202,
            headers: {
              'Operation-Location': `https://translator.example.com/translator/document/batches/${OPERATION_ID}?api-version=2024-05-01`,
            },
          }),
      );
      globalThis.fetch = fetchSpy as never;

      const operationId = await service.submitBatchTranslation({
        sourceSasUrl: 'https://blob.example.com/src?sig=source-sas',
        targetSasUrl: 'https://blob.example.com/dst?sig=target-sas',
        targetLanguage: 'fr',
        sourceLanguage: 'en',
      });

      expect(operationId).toBe(OPERATION_ID);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/translator/document/batches');
      expect(String(url)).toContain('api-version=2024-05-01');
      const body = JSON.parse(String(init?.body));
      expect(body.inputs[0].storageType).toBe('File');
      expect(body.inputs[0].source).toEqual({
        sourceUrl: 'https://blob.example.com/src?sig=source-sas',
        language: 'en',
      });
      expect(body.inputs[0].targets[0]).toEqual({
        targetUrl: 'https://blob.example.com/dst?sig=target-sas',
        language: 'fr',
      });
    });

    it('includes a glossary entry when provided', async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(null, {
            status: 202,
            headers: {
              'Operation-Location': `https://x.example.com/translator/document/batches/${OPERATION_ID}`,
            },
          }),
      );
      globalThis.fetch = fetchSpy as never;

      await service.submitBatchTranslation({
        sourceSasUrl: 'https://blob.example.com/src?sas',
        targetSasUrl: 'https://blob.example.com/dst?sas',
        targetLanguage: 'fr',
        glossarySasUrl: 'https://blob.example.com/glossary.csv?sas',
      });

      const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
      expect(body.inputs[0].targets[0].glossaries).toEqual([
        {
          glossaryUrl: 'https://blob.example.com/glossary.csv?sas',
          format: 'csv',
        },
      ]);
    });

    it('throws the Azure error message on non-202 responses', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: 'Target blob already exists' },
            }),
            { status: 400 },
          ),
      ) as never;

      await expect(
        service.submitBatchTranslation({
          sourceSasUrl: 'https://blob.example.com/src?sas',
          targetSasUrl: 'https://blob.example.com/dst?sas',
          targetLanguage: 'fr',
        }),
      ).rejects.toThrow('Target blob already exists');
    });

    it('throws when the 202 lacks an Operation-Location header', async () => {
      globalThis.fetch = vi.fn(
        async () => new Response(null, { status: 202 }),
      ) as never;

      await expect(
        service.submitBatchTranslation({
          sourceSasUrl: 'https://blob.example.com/src?sas',
          targetSasUrl: 'https://blob.example.com/dst?sas',
          targetLanguage: 'fr',
        }),
      ).rejects.toThrow(/Operation-Location/);
    });
  });

  describe('getBatchTranslationStatus', () => {
    const statusResponse = (status: string, error?: { message: string }) =>
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status, ...(error ? { error } : {}) }),
            {
              status: 200,
            },
          ),
      );

    it.each([
      ['NotStarted', 'Running'],
      ['Running', 'Running'],
      ['Succeeded', 'Succeeded'],
    ])('maps Azure %s → %s', async (azure, expected) => {
      globalThis.fetch = statusResponse(azure) as never;
      const result = await service.getBatchTranslationStatus(OPERATION_ID);
      expect(result.status).toBe(expected);
      expect(result.azureStatus).toBe(azure);
    });

    it.each(['Failed', 'ValidationFailed', 'Cancelled'])(
      'maps Azure %s → Failed with the error message',
      async (azure) => {
        globalThis.fetch = statusResponse(azure, {
          message: 'Document format is not supported',
        }) as never;

        const result = await service.getBatchTranslationStatus(OPERATION_ID);

        expect(result.status).toBe('Failed');
        expect(result.error).toBe('Document format is not supported');
      },
    );

    it('polls the operation-specific URL with the bearer token', async () => {
      const fetchSpy = statusResponse('Running');
      globalThis.fetch = fetchSpy as never;

      await service.getBatchTranslationStatus(OPERATION_ID);

      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain(
        `/translator/document/batches/${OPERATION_ID}`,
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer mock-bearer-token',
      );
    });
  });
});

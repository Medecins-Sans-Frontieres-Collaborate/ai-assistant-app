/**
 * Tests for the Azure Speech batch transcription client's authentication:
 * every call goes to the account custom-domain endpoint with an Entra bearer
 * token from the application identity, and an unconfigured service fails
 * before reaching the network.
 */
import { BatchTranscriptionService } from '@/lib/services/transcription/batchTranscriptionService';

import { resetCognitiveServicesAuthForTests } from '@/lib/utils/server/azure/cognitiveServicesAuth';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SPEECH_ENDPOINT = 'https://test-account.cognitiveservices.azure.com';
const JOB_ID = '0f6302da-442d-5217-9734-b79d4793c2eb';

const mockEnv = vi.hoisted(
  () =>
    ({}) as { AZURE_SPEECH_ENDPOINT?: string; AZURE_OPENAI_ENDPOINT?: string },
);
vi.mock('@/config/environment', () => ({ env: mockEnv }));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  getBearerTokenProvider: () => async () => 'test-entra-token',
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('BatchTranscriptionService', () => {
  beforeEach(() => {
    resetCognitiveServicesAuthForTests();
    delete mockEnv.AZURE_SPEECH_ENDPOINT;
    mockEnv.AZURE_OPENAI_ENDPOINT = `${SPEECH_ENDPOINT}/`;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });

  it('submits to the custom-domain endpoint with a bearer token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        self: `${SPEECH_ENDPOINT}/speechtotext/v3.2/transcriptions/${JOB_ID}`,
      }),
    );
    const service = new BatchTranscriptionService();

    expect(service.isConfigured()).toBe(true);
    expect(
      await service.submitTranscription('https://blob/audio.mp3?sas', 'fr-FR'),
    ).toBe(JOB_ID);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SPEECH_ENDPOINT}/speechtotext/v3.2/transcriptions`);
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-entra-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.has('Ocp-Apim-Subscription-Key')).toBe(false);
    expect(JSON.parse(init.body)).toMatchObject({
      contentUrls: ['https://blob/audio.mp3?sas'],
      locale: 'fr-FR',
    });
  });

  it('authenticates status, files and delete calls the same way', async () => {
    const service = new BatchTranscriptionService();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: 'Running' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await service.getStatus(JOB_ID);
    await service.deleteTranscription(JOB_ID);

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(
        `${SPEECH_ENDPOINT}/speechtotext/v3.2/transcriptions/${JOB_ID}`,
      );
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer test-entra-token',
      );
    }
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });

  it('downloads the result file from its SAS link without a bearer token', async () => {
    const contentUrl = 'https://speech-results.blob/transcript.json?sas';
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          values: [{ kind: 'Transcription', links: { contentUrl } }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          combinedRecognizedPhrases: [{ display: 'Bonjour.' }],
        }),
      );

    expect(await new BatchTranscriptionService().getTranscript(JOB_ID)).toBe(
      'Bonjour.',
    );
    expect(fetchMock.mock.calls[1]).toEqual([contentUrl]);
  });

  it('fails before the network when no Speech endpoint is configured', async () => {
    delete mockEnv.AZURE_OPENAI_ENDPOINT;
    const service = new BatchTranscriptionService();

    expect(service.isConfigured()).toBe(false);
    await expect(service.getStatus(JOB_ID)).rejects.toThrow(
      /AZURE_SPEECH_ENDPOINT/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

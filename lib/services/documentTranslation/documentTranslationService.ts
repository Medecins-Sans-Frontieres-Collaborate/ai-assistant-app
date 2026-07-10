/**
 * Azure Document Translation Service
 *
 * Provides synchronous document translation using Azure Cognitive Services
 * Translator Document Translation API.
 *
 * Supports Word, Excel, PowerPoint, PDF, HTML, and other document formats.
 * @see https://learn.microsoft.com/en-us/azure/ai-services/translator/document-translation/overview
 */
import {
  DocumentTranslationOptions,
  getDocumentContentType,
  getGlossaryContentType,
} from '@/types/documentTranslation';

import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';

/** Azure Translator API version for document translation */
const API_VERSION = '2024-05-01';

/**
 * Service for translating documents using Azure Document Translation API.
 * Uses synchronous single-file translation for optimal user experience.
 */
export class DocumentTranslationService {
  private endpoint: string;
  private tokenProvider: () => Promise<string>;

  /**
   * Creates a new DocumentTranslationService instance.
   *
   * Falls back to AZURE_AI_FOUNDRY_ENDPOINT if AZURE_TRANSLATOR_ENDPOINT is not set.
   *
   * @throws Error if neither endpoint environment variable is set
   */
  constructor() {
    const endpoint =
      process.env.AZURE_TRANSLATOR_ENDPOINT ||
      process.env.AZURE_AI_FOUNDRY_ENDPOINT;
    if (!endpoint) {
      throw new Error(
        'Neither AZURE_TRANSLATOR_ENDPOINT nor AZURE_AI_FOUNDRY_ENDPOINT environment variable is configured. ' +
          'Set one of these to your Azure AI resource endpoint.',
      );
    }
    this.endpoint = endpoint.replace(/\/$/, ''); // Remove trailing slash if present

    // Use DefaultAzureCredential for managed identity / local dev auth
    const credential = new DefaultAzureCredential();
    const scope = 'https://cognitiveservices.azure.com/.default';
    this.tokenProvider = getBearerTokenProvider(credential, scope);
  }

  /**
   * Translates a document using Azure Document Translation API (synchronous).
   *
   * @param documentBuffer - Binary content of the document to translate
   * @param filename - Original filename (used for content-type detection)
   * @param options - Translation options including target language
   * @param glossaryBuffer - Optional glossary file content
   * @param glossaryFilename - Optional glossary filename (for content-type detection)
   * @returns Promise resolving to the translated document as a Buffer
   * @throws Error if translation fails
   */
  async translateDocument(
    documentBuffer: Buffer,
    filename: string,
    options: DocumentTranslationOptions,
    glossaryBuffer?: Buffer,
    glossaryFilename?: string,
  ): Promise<Buffer> {
    const token = await this.tokenProvider();

    // Build request URL with query parameters
    const url = new URL(`${this.endpoint}/translator/document:translate`);
    url.searchParams.set('api-version', API_VERSION);
    url.searchParams.set('targetLanguage', options.targetLanguage);

    if (options.sourceLanguage) {
      url.searchParams.set('sourceLanguage', options.sourceLanguage);
    }

    if (options.category) {
      url.searchParams.set('category', options.category);
    }

    // Prepare multipart form data
    const formData = new FormData();

    // Add the document (convert Buffer to Uint8Array for Blob compatibility)
    const documentContentType = getDocumentContentType(filename);
    const documentBlob = new Blob([new Uint8Array(documentBuffer)], {
      type: documentContentType,
    });
    formData.append('document', documentBlob, filename);

    // Add glossary if provided
    if (glossaryBuffer && glossaryFilename) {
      const glossaryContentType = getGlossaryContentType(glossaryFilename);
      const glossaryBlob = new Blob([new Uint8Array(glossaryBuffer)], {
        type: glossaryContentType,
      });
      formData.append('glossary', glossaryBlob, glossaryFilename);
    }

    console.log(
      `[DocumentTranslation] Translating ${filename} to ${options.targetLanguage}`,
      {
        documentSize: documentBuffer.length,
        hasGlossary: !!glossaryBuffer,
        sourceLanguage: options.sourceLanguage || 'auto-detect',
      },
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        // Note: Content-Type is automatically set by FormData
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage = `Document translation failed: HTTP ${response.status}`;

      try {
        const errorJson = JSON.parse(errorBody);
        if (errorJson.error?.message) {
          errorMessage = errorJson.error.message;
        } else if (errorJson.message) {
          errorMessage = errorJson.message;
        }
      } catch {
        // If parsing fails, use the raw error body if available
        if (errorBody) {
          errorMessage = `${errorMessage} - ${errorBody.substring(0, 500)}`;
        }
      }

      console.error('[DocumentTranslation] Translation failed:', {
        status: response.status,
        error: errorMessage,
        filename,
        targetLanguage: options.targetLanguage,
      });

      throw new Error(errorMessage);
    }

    // Response is the translated document as binary stream
    const arrayBuffer = await response.arrayBuffer();
    const translatedBuffer = Buffer.from(arrayBuffer);

    console.log('[DocumentTranslation] Translation successful:', {
      originalSize: documentBuffer.length,
      translatedSize: translatedBuffer.length,
      filename,
      targetLanguage: options.targetLanguage,
    });

    return translatedBuffer;
  }

  /**
   * Submits an ASYNCHRONOUS (batch) translation for a single document.
   *
   * Used for formats the synchronous endpoint doesn't handle (PDF). With
   * `storageType: 'File'` the batch translates one blob into one blob, so no
   * dedicated source/target containers are needed: the source is the
   * already-uploaded original (read SAS) and the target is the standard
   * translated-blob path the sync flow uses (write SAS) — meaning the
   * existing /api/document-translation/content download route serves batch
   * results unchanged. NOTE: the target blob must not exist yet; Azure
   * writes it on completion.
   *
   * @returns The batch operation id (from the Operation-Location header)
   * @see https://learn.microsoft.com/en-us/azure/ai-services/translator/document-translation/reference/rest-api-guide
   */
  async submitBatchTranslation(options: {
    sourceSasUrl: string;
    targetSasUrl: string;
    targetLanguage: string;
    sourceLanguage?: string;
    category?: string;
    glossarySasUrl?: string;
    glossaryFormat?: string;
  }): Promise<string> {
    const token = await this.tokenProvider();
    const url = new URL(`${this.endpoint}/translator/document/batches`);
    url.searchParams.set('api-version', API_VERSION);

    const body = {
      inputs: [
        {
          storageType: 'File',
          source: {
            sourceUrl: options.sourceSasUrl,
            ...(options.sourceLanguage
              ? { language: options.sourceLanguage }
              : {}),
          },
          targets: [
            {
              targetUrl: options.targetSasUrl,
              language: options.targetLanguage,
              ...(options.category ? { category: options.category } : {}),
              ...(options.glossarySasUrl
                ? {
                    glossaries: [
                      {
                        glossaryUrl: options.glossarySasUrl,
                        format: options.glossaryFormat ?? 'csv',
                      },
                    ],
                  }
                : {}),
            },
          ],
        },
      ],
    };

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.status !== 202) {
      const errorBody = await response.text();
      let errorMessage = `Batch translation submit failed: HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage =
          errorJson.error?.message ?? errorJson.message ?? errorMessage;
      } catch {
        if (errorBody) {
          errorMessage = `${errorMessage} - ${errorBody.substring(0, 500)}`;
        }
      }
      console.error('[DocumentTranslation] Batch submit failed:', {
        status: response.status,
        error: errorMessage,
        targetLanguage: options.targetLanguage,
      });
      throw new Error(errorMessage);
    }

    // Operation-Location: {endpoint}/translator/document/batches/{id}?api-version=…
    const operationLocation = response.headers.get('operation-location');
    const operationId = operationLocation
      ?.split('?')[0]
      ?.split('/')
      .filter(Boolean)
      .pop();
    if (!operationId) {
      throw new Error(
        'Batch translation submit succeeded but no Operation-Location header was returned',
      );
    }
    console.log('[DocumentTranslation] Batch submitted:', {
      operationId,
      targetLanguage: options.targetLanguage,
    });
    return operationId;
  }

  /**
   * Polls a batch translation operation.
   *
   * Maps Azure batch statuses onto the app's transcription-style trio so the
   * status route/UI can reuse the established polling contract.
   */
  async getBatchTranslationStatus(operationId: string): Promise<{
    status: 'Running' | 'Succeeded' | 'Failed';
    azureStatus: string;
    error?: string;
  }> {
    const token = await this.tokenProvider();
    const url = new URL(
      `${this.endpoint}/translator/document/batches/${encodeURIComponent(operationId)}`,
    );
    url.searchParams.set('api-version', API_VERSION);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `Batch translation status failed: HTTP ${response.status}`,
      );
    }
    const json = (await response.json()) as {
      status?: string;
      error?: { message?: string };
      summary?: { failed?: number };
    };

    const azureStatus = json.status ?? 'Unknown';
    switch (azureStatus) {
      case 'Succeeded':
        return { status: 'Succeeded', azureStatus };
      case 'Failed':
      case 'ValidationFailed':
      case 'Cancelled':
      case 'Cancelling':
        return {
          status: 'Failed',
          azureStatus,
          error: json.error?.message ?? `Translation ${azureStatus}`,
        };
      default:
        // NotStarted / Running / anything unrecognized → keep polling.
        return { status: 'Running', azureStatus };
    }
  }

  /**
   * Checks if the service is properly configured.
   *
   * @returns True if the endpoint is configured
   */
  isConfigured(): boolean {
    return !!this.endpoint;
  }

  /**
   * Gets the configured endpoint (for debugging/logging).
   *
   * @returns The Azure Translator endpoint URL
   */
  getEndpoint(): string {
    return this.endpoint;
  }
}

/**
 * Creates a new DocumentTranslationService instance.
 * Factory function for consistent service instantiation.
 *
 * @returns A new DocumentTranslationService instance
 */
export function createDocumentTranslationService(): DocumentTranslationService {
  return new DocumentTranslationService();
}

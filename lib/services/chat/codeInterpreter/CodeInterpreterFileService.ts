/**
 * CodeInterpreterFileService
 *
 * Handles file operations for Azure AI Foundry Code Interpreter:
 * - Uploading files to AI Foundry for agent use
 * - Downloading generated files from containers
 * - Managing file lifecycle
 */
import {
  CodeInterpreterFile,
  getCodeInterpreterMimeType,
  isCodeInterpreterSupported,
} from '@/types/codeInterpreter';

import { env } from '@/config/environment';
import { DefaultAzureCredential, TokenCredential } from '@azure/identity';
import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Service for handling Code Interpreter file operations.
 *
 * Uses the Azure AI Agents SDK for file upload/download operations.
 * Files are uploaded with purpose='assistants' for use by Code Interpreter.
 */
export class CodeInterpreterFileService {
  private tracer = trace.getTracer('code-interpreter-file-service');
  private credential: TokenCredential;

  constructor() {
    this.credential = new DefaultAzureCredential();
  }

  /**
   * Uploads a file to AI Foundry for Code Interpreter use.
   *
   * @param buffer - File content as Buffer
   * @param filename - Original filename
   * @returns CodeInterpreterFile with assigned ID
   * @throws Error if upload fails or file type is unsupported
   */
  async uploadFile(
    buffer: Buffer,
    filename: string,
  ): Promise<CodeInterpreterFile> {
    return await this.tracer.startActiveSpan(
      'code_interpreter.upload_file',
      {
        attributes: {
          'file.name': filename,
          'file.size': buffer.length,
        },
      },
      async (span) => {
        try {
          // Validate file type
          if (!isCodeInterpreterSupported(filename)) {
            throw new Error(
              `File type not supported by Code Interpreter: ${filename}`,
            );
          }

          const mimeType = getCodeInterpreterMimeType(filename);

          // Use Azure AI Agents SDK for file upload
          const aiAgents = await import('@azure/ai-agents');
          const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;

          if (!endpoint) {
            throw new Error('Azure AI Foundry endpoint not configured');
          }

          const client = new aiAgents.AgentsClient(endpoint, this.credential);

          // Create a File object from the buffer
          // The SDK expects a File-like object with name property
          const file = new File([buffer], filename, {
            type: mimeType || 'application/octet-stream',
          });

          // Upload file with purpose='assistants' for Code Interpreter use
          const uploadResult = await client.files.upload(file, 'assistants');

          console.log('[CodeInterpreterFileService] File uploaded:', {
            id: uploadResult.id,
            filename: uploadResult.filename,
            purpose: uploadResult.purpose,
            bytes: uploadResult.bytes,
          });

          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('file.id', uploadResult.id);

          return {
            id: uploadResult.id,
            filename: uploadResult.filename || filename,
            purpose: 'assistants',
            mimeType,
            size: uploadResult.bytes,
          };
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Upload failed',
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Uploads multiple files concurrently.
   *
   * @param files - Array of file buffers and filenames
   * @returns Array of uploaded CodeInterpreterFile objects
   */
  async uploadFiles(
    files: Array<{ buffer: Buffer; filename: string }>,
  ): Promise<CodeInterpreterFile[]> {
    // Filter to only supported files
    const supportedFiles = files.filter((f) =>
      isCodeInterpreterSupported(f.filename),
    );

    if (supportedFiles.length === 0) {
      console.log('[CodeInterpreterFileService] No supported files to upload', {
        total: files.length,
        unsupported: files.map((f) => f.filename),
      });
      return [];
    }

    console.log('[CodeInterpreterFileService] Uploading files:', {
      total: supportedFiles.length,
      filenames: supportedFiles.map((f) => f.filename),
    });

    // Upload all files concurrently
    const uploadPromises = supportedFiles.map((file) =>
      this.uploadFile(file.buffer, file.filename),
    );

    return Promise.all(uploadPromises);
  }

  /**
   * Downloads a generated file from an AI Foundry container.
   *
   * @param fileId - The file ID to download
   * @param containerId - The container ID where the file is stored
   * @returns File content as Buffer
   */
  async downloadGeneratedFile(
    fileId: string,
    containerId: string,
  ): Promise<Buffer> {
    return await this.tracer.startActiveSpan(
      'code_interpreter.download_file',
      {
        attributes: {
          'file.id': fileId,
          'container.id': containerId,
        },
      },
      async (span) => {
        try {
          const aiAgents = await import('@azure/ai-agents');
          const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;

          if (!endpoint) {
            throw new Error('Azure AI Foundry endpoint not configured');
          }

          const client = new aiAgents.AgentsClient(endpoint, this.credential);

          // Download file content from container
          // Note: The exact API may vary based on SDK version
          const content = await client.files.getContent(fileId);

          // Convert ReadableStream to Buffer
          const chunks: Uint8Array[] = [];
          const reader = content.body?.getReader();

          if (!reader) {
            throw new Error('No response body received');
          }

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }

          const buffer = Buffer.concat(chunks);

          console.log('[CodeInterpreterFileService] File downloaded:', {
            fileId,
            containerId,
            size: buffer.length,
          });

          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('file.downloaded_size', buffer.length);

          return buffer;
        } catch (error) {
          console.error('[CodeInterpreterFileService] Download failed:', error);
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Download failed',
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Deletes a file from AI Foundry.
   *
   * @param fileId - The file ID to delete
   */
  async deleteFile(fileId: string): Promise<void> {
    return await this.tracer.startActiveSpan(
      'code_interpreter.delete_file',
      {
        attributes: {
          'file.id': fileId,
        },
      },
      async (span) => {
        try {
          const aiAgents = await import('@azure/ai-agents');
          const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;

          if (!endpoint) {
            throw new Error('Azure AI Foundry endpoint not configured');
          }

          const client = new aiAgents.AgentsClient(endpoint, this.credential);

          await client.files.delete(fileId);

          console.log('[CodeInterpreterFileService] File deleted:', { fileId });

          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          console.error('[CodeInterpreterFileService] Delete failed:', error);
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Delete failed',
          });
          // Don't throw - deletion failures are not critical
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Gets file metadata from AI Foundry.
   *
   * @param fileId - The file ID to retrieve
   * @returns File metadata
   */
  async getFile(fileId: string): Promise<CodeInterpreterFile | null> {
    try {
      const aiAgents = await import('@azure/ai-agents');
      const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;

      if (!endpoint) {
        throw new Error('Azure AI Foundry endpoint not configured');
      }

      const client = new aiAgents.AgentsClient(endpoint, this.credential);

      const file = await client.files.get(fileId);

      return {
        id: file.id,
        filename: file.filename || 'unknown',
        purpose: 'assistants',
        size: file.bytes,
      };
    } catch (error) {
      console.error('[CodeInterpreterFileService] Get file failed:', error);
      return null;
    }
  }
}

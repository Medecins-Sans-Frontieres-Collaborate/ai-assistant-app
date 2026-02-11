import { Session } from 'next-auth';

import { getEnvVariable } from '@/lib/utils/app/env';

import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  BlockBlobClient,
  BlockBlobUploadOptions,
  ContainerClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import {
  DequeuedMessageItem,
  QueueClient,
  QueueDeleteMessageResponse,
  QueueSendMessageResponse,
  QueueServiceClient,
  StorageSharedKeyCredential as QueueSharedKeyCredential,
} from '@azure/storage-queue';
import { lookup } from 'mime-types';
import { performance } from 'perf_hooks';
import { Readable } from 'stream';

export enum BlobProperty {
  URL = 'url',
  BLOB = 'blob',
}

export enum BlobStorageType {
  AZURE = 'azure',
  AWS = 'aws',
}

export interface UploadStreamAzureStorageArgs {
  blobName: string;
  contentStream: Readable;
  bufferSize?: number | undefined;
  maxConcurrency?: number | undefined;
  options?: BlockBlobUploadOptions | undefined;
}

export interface BlobStorage {
  upload(
    blobName: string,
    content: string | Buffer,
    options?: BlockBlobUploadOptions | undefined,
  ): Promise<string>;
  uploadStream({
    blobName,
    contentStream,
    bufferSize,
    maxConcurrency,
    options,
  }: UploadStreamAzureStorageArgs): Promise<string>;
  get(
    blobName: string,
    property: BlobProperty,
  ): Promise<string | Blob | Buffer>;
  blobExists(blobName: string): Promise<boolean>;
  getBlockBlobClient(blobName: string): BlockBlobClient;
  getBlobSize(blobName: string): Promise<number>;
  /**
   * Generates a SAS URL for accessing the blob with read permissions.
   * Used for batch transcription API which requires a publicly accessible URL.
   *
   * @param blobName - The blob path
   * @param expiryHours - Hours until the SAS token expires (default: 24)
   * @returns Promise resolving to the SAS URL
   */
  generateSasUrl(blobName: string, expiryHours?: number): Promise<string>;
  /**
   * Stages a block as part of a chunked upload.
   * Used with Azure Block Blob API for uploading large files in chunks.
   *
   * @param blobName - The blob path
   * @param blockId - Base64-encoded block ID (must be consistent length, e.g., padded index)
   * @param content - The chunk data
   * @returns Promise that resolves when block is staged
   */
  stageBlock(blobName: string, blockId: string, content: Buffer): Promise<void>;
  /**
   * Commits a list of blocks to form the final blob.
   * Called after all chunks have been staged with stageBlock.
   *
   * @param blobName - The blob path
   * @param blockIds - Array of block IDs in order (must match staged block IDs)
   * @param options - Optional upload options (e.g., content type headers)
   * @returns Promise resolving to the blob URL
   */
  commitBlockList(
    blobName: string,
    blockIds: string[],
    options?: BlockBlobUploadOptions,
  ): Promise<string>;
}

export interface QueueStorage {
  createQueue(queueName: string): Promise<void>;
  addMessage(
    queueName: string,
    message: string,
  ): Promise<QueueSendMessageResponse>;
  updateMessage(
    queueName: string,
    messageId: string,
    popReceipt: string,
    messageText: string,
    visibilityTimeout?: number,
  ): Promise<void>;
  deleteMessage(
    queueName: string,
    messageId: string,
    popReceipt: string,
  ): Promise<void>;
  receiveMessages(
    queueName: string,
    maxMessages?: number,
    visibilityTimeout?: number,
  ): Promise<DequeuedMessageItem[]>;
}

export class AzureBlobStorage implements BlobStorage, QueueStorage {
  private blobServiceClient: BlobServiceClient;
  private queueServiceClient: QueueServiceClient;

  constructor(
    storageAccountName: string | undefined = undefined,
    private containerName: string | undefined = undefined,
    private user: Session['user'],
  ) {
    let name: string;
    if (!storageAccountName) {
      name = getEnvVariable({ name: 'AZURE_BLOB_STORAGE_NAME', user });
    } else {
      name = storageAccountName;
    }

    if (!this.containerName) {
      this.containerName = getEnvVariable({
        name: 'AZURE_BLOB_STORAGE_CONTAINER',
        throwErrorOnFail: false,
        defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
        user,
      });
    }

    // Use Azure Entra ID (DefaultAzureCredential) for authentication
    const credential = new DefaultAzureCredential();

    this.blobServiceClient = new BlobServiceClient(
      `https://${name}.blob.core.windows.net`,
      credential,
    );

    this.queueServiceClient = new QueueServiceClient(
      `https://${name}.queue.core.windows.net`,
      credential,
    );
  }

  async upload(
    blobName: string,
    content: string | Buffer,
    options?: BlockBlobUploadOptions | undefined,
  ): Promise<string> {
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const perfStart = performance.now();

    if (await this.blobExists(blobName)) {
      console.log(
        `[Perf] AzureBlobStorage.upload: ${(performance.now() - perfStart).toFixed(1)}ms`,
      );
      return blockBlobClient.url;
    }

    let uploadContent: string | Buffer;
    let contentLength: number;

    if (Buffer.isBuffer(content)) {
      uploadContent = content;
      contentLength = content.length;
    } else if (typeof content === 'string') {
      uploadContent = content;
      contentLength = Buffer.byteLength(content);
    } else if (Array.isArray(content)) {
      uploadContent = content[0];
      contentLength = Buffer.byteLength(content[0]);
    } else {
      throw new Error(
        'Invalid content type. Expected string, Buffer, or array of strings.',
      );
    }

    await blockBlobClient.upload(uploadContent, contentLength, options);
    console.log(
      `[Perf] AzureBlobStorage.upload: ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return blockBlobClient.url;
  }

  async uploadStream({
    blobName,
    contentStream,
    bufferSize,
    maxConcurrency,
    options,
  }: UploadStreamAzureStorageArgs): Promise<string> {
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    if (await this.blobExists(blobName)) {
      return blockBlobClient.url;
    }

    await blockBlobClient.uploadStream(
      contentStream,
      bufferSize,
      maxConcurrency,
      options,
    );
    return blockBlobClient.url;
  }

  async get(
    blobName: string,
    property = BlobProperty.URL,
  ): Promise<string | Buffer> {
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    if (property === BlobProperty.URL) {
      return blockBlobClient.url;
    } else if (property === BlobProperty.BLOB) {
      try {
        const perfStart = performance.now();
        const downloadResponse = await blockBlobClient.download();
        console.log(
          `[Perf] AzureBlobStorage.get download: ${(performance.now() - perfStart).toFixed(1)}ms`,
        );

        if (!downloadResponse.readableStreamBody) {
          throw new Error('No readable stream available');
        }

        const perfStreamStart = performance.now();
        const buffer = await this.streamToBuffer(
          downloadResponse.readableStreamBody,
        );
        console.log(
          `[Perf] AzureBlobStorage.get streamToBuffer: ${(performance.now() - perfStreamStart).toFixed(1)}ms`,
        );
        console.log(
          `[Perf] AzureBlobStorage.get total: ${(performance.now() - perfStart).toFixed(1)}ms`,
        );
        return buffer;
      } catch (error) {
        console.error('Error downloading blob:', error);
        throw error;
      }
    } else {
      throw new Error('Invalid property type specified.');
    }
  }

  async blobExists(blobName: string): Promise<boolean> {
    const perfStart = performance.now();
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const result = await blockBlobClient.exists();
    console.log(
      `[Perf] AzureBlobStorage.blobExists: ${(performance.now() - perfStart).toFixed(1)}ms (${result})`,
    );
    return result;
  }

  async getBlobSize(blobName: string): Promise<number> {
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const properties = await blockBlobClient.getProperties();
    return properties.contentLength || 0;
  }

  async createContainer(containerName: string): Promise<void> {
    await this.blobServiceClient.createContainer(containerName);
  }

  async blobToString(blob: Blob): Promise<string> {
    const fileReader = new FileReader();
    return new Promise<string>((resolve, reject) => {
      fileReader.onloadend = (ev: any) => {
        resolve(ev.target!.result as string);
      };
      fileReader.onerror = reject;
      fileReader.readAsText(blob);
    });
  }

  private async streamToBuffer(
    readableStream: NodeJS.ReadableStream,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: any[] = [];
      readableStream.on('data', (data) => {
        chunks.push(data instanceof Buffer ? data : Buffer.from(data));
      });
      readableStream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      readableStream.on('error', reject);
    });
  }

  /**
   * Gets a BlockBlobClient for the specified blob.
   * @param blobName The name/path of the blob.
   * @returns The BlockBlobClient for the blob.
   */
  getBlockBlobClient(blobName: string): BlockBlobClient {
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    return containerClient.getBlockBlobClient(blobName);
  }

  getContainerClient(): ContainerClient {
    return this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
  }

  /**
   * Generates a SAS URL for accessing the blob with read permissions.
   * Uses user delegation key from Azure Entra ID for authentication.
   *
   * @param blobName - The blob path
   * @param expiryHours - Hours until the SAS token expires (default: 24)
   * @returns Promise resolving to the SAS URL
   */
  async generateSasUrl(blobName: string, expiryHours = 24): Promise<string> {
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Calculate expiry time
    const startsOn = new Date();
    const expiresOn = new Date(
      startsOn.getTime() + expiryHours * 60 * 60 * 1000,
    );

    // Get user delegation key from the service
    const userDelegationKey = await this.blobServiceClient.getUserDelegationKey(
      startsOn,
      expiresOn,
    );

    // Generate the SAS token with read permission
    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: this.containerName as string,
        blobName,
        permissions: BlobSASPermissions.parse('r'), // Read only
        startsOn,
        expiresOn,
      },
      userDelegationKey,
      this.blobServiceClient.accountName,
    ).toString();

    return `${blockBlobClient.url}?${sasToken}`;
  }

  /**
   * Stages a block as part of a chunked upload.
   * The block is identified by a base64-encoded blockId and will be committed
   * later using commitBlockList.
   *
   * @param blobName - The blob path
   * @param blockId - Base64-encoded block ID
   * @param content - The chunk data as a Buffer
   */
  async stageBlock(
    blobName: string,
    blockId: string,
    content: Buffer,
  ): Promise<void> {
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.stageBlock(blockId, content, content.length);
  }

  /**
   * Commits a list of previously staged blocks to form the final blob.
   * Block IDs must be provided in the order they should appear in the final blob.
   *
   * @param blobName - The blob path
   * @param blockIds - Array of base64-encoded block IDs in order
   * @param options - Optional upload options (e.g., HTTP headers for content type)
   * @returns The URL of the committed blob
   */
  async commitBlockList(
    blobName: string,
    blockIds: string[],
    options?: BlockBlobUploadOptions,
  ): Promise<string> {
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.commitBlockList(blockIds, options);
    return blockBlobClient.url;
  }

  // Queue methods
  async createQueue(queueName: string): Promise<void> {
    const queueClient = this.queueServiceClient.getQueueClient(queueName);
    await queueClient.create();
  }

  async addMessage(
    queueName: string,
    message: string,
  ): Promise<QueueSendMessageResponse> {
    const queueClient = this.queueServiceClient.getQueueClient(queueName);
    return await queueClient.sendMessage(message);
  }

  getQueueClient(queueName: string): QueueClient {
    return this.queueServiceClient.getQueueClient(queueName);
  }

  async updateMessage(
    queueName: string,
    messageId: string,
    popReceipt: string,
    messageText: string,
    visibilityTimeout?: number,
  ): Promise<void> {
    const queueClient = this.queueServiceClient.getQueueClient(queueName);
    await queueClient.updateMessage(
      messageId,
      popReceipt,
      messageText,
      visibilityTimeout,
    );
  }

  async deleteMessage(
    queueName: string,
    messageId: string,
    popReceipt: string,
  ): Promise<void> {
    const queueClient = this.queueServiceClient.getQueueClient(queueName);
    await queueClient.deleteMessage(messageId, popReceipt);
  }

  async receiveMessages(
    queueName: string,
    maxMessages = 1,
    visibilityTimeout?: number,
  ): Promise<DequeuedMessageItem[]> {
    const queueClient = this.queueServiceClient.getQueueClient(queueName);
    const response = await queueClient.receiveMessages({
      numberOfMessages: maxMessages,
      visibilityTimeout,
    });
    return response.receivedMessageItems;
  }
}

export default class BlobStorageFactory {
  static createAzureBlobStorage(
    storageAccountName: string,
    containerName: string,
    type: BlobStorageType = BlobStorageType.AZURE,
    user: Session['user'],
  ): BlobStorage | AzureBlobStorage {
    switch (type) {
      case BlobStorageType.AZURE:
        return new AzureBlobStorage(storageAccountName, containerName, user);
      case BlobStorageType.AWS:
        throw new Error('AWS blob storage support not implemented.');
      default:
        throw new Error(`Invalid blob storage type provided: ${type}`);
    }
  }
}

type BlobType = 'files' | 'images' | 'audio' | 'video';

export const getBlobBase64String = async (
  userId: string,
  id: string,
  blobType: BlobType = 'images',
  user: Session['user'],
): Promise<string> => {
  const blobStorageClient: BlobStorage = new AzureBlobStorage(
    getEnvVariable({ name: 'AZURE_BLOB_STORAGE_NAME', user }),
    getEnvVariable({
      name: 'AZURE_BLOB_STORAGE_CONTAINER',
      throwErrorOnFail: false,
      defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
      user,
    }),
    user,
  );
  const blobLocation: string = `${userId}/uploads/${blobType}/${id}`;
  const blob: Buffer = await (blobStorageClient.get(
    blobLocation,
    BlobProperty.BLOB,
  ) as Promise<Buffer>);

  // Check if content is already a data URL string (images are stored this way)
  const contentString = blob.toString('utf8');
  if (contentString.startsWith('data:')) {
    return contentString;
  }

  // Check if it's raw base64 (legacy format - stored without data: prefix)
  // Raw base64 starts with valid base64 chars and contains no null bytes
  const isLikelyRawBase64 =
    /^[A-Za-z0-9+/]/.test(contentString) &&
    !contentString.includes('\x00') &&
    /^[A-Za-z0-9+/=\s]+$/.test(contentString.slice(0, 100));

  if (isLikelyRawBase64) {
    const extension = blobLocation.split('.').pop() || '';
    const mimeType = lookup(extension);
    if (mimeType) {
      // Wrap the raw base64 with the data URL prefix
      return `data:${mimeType};base64,${contentString}`;
    }
  }

  // Otherwise, it's binary content - encode to base64
  const base64Data = blob.toString('base64');
  const extension = blobLocation.split('.').pop() || '';
  const mimeType = lookup(extension);

  if (!mimeType) {
    throw new Error(`Couldn't determine mime type for: ${blobLocation}`);
  }

  return `data:${mimeType};base64,${base64Data}`;
};

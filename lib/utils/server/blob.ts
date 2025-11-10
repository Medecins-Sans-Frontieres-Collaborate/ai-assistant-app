import { Session } from 'next-auth';

import { getEnvVariable } from '@/lib/utils/app/env';

import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobServiceClient,
  BlockBlobClient,
  BlockBlobUploadOptions,
  ContainerClient,
  StorageSharedKeyCredential,
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
    storageAccountAccessKey: string | undefined = undefined,
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

    if (await this.blobExists(blobName)) {
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
        const downloadResponse = await blockBlobClient.download();

        if (!downloadResponse.readableStreamBody) {
          throw new Error('No readable stream available');
        }

        return this.streamToBuffer(downloadResponse.readableStreamBody);
      } catch (error) {
        console.error('Error downloading blob:', error);
        throw error;
      }
    } else {
      throw new Error('Invalid property type specified.');
    }
  }

  async blobExists(blobName: string): Promise<boolean> {
    const containerClient = this.blobServiceClient.getContainerClient(
      this.containerName as string,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    return blockBlobClient.exists();
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
    storageAccountAccessKey: string | undefined,
    containerName: string,
    type: BlobStorageType = BlobStorageType.AZURE,
    user: Session['user'],
  ): BlobStorage | AzureBlobStorage {
    switch (type) {
      case BlobStorageType.AZURE:
        return new AzureBlobStorage(
          storageAccountName,
          storageAccountAccessKey,
          containerName,
          user,
        );
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
  // Uses DefaultAzureCredential (Entra ID), key is optional
  const storageKey = getEnvVariable({
    name: 'AZURE_BLOB_STORAGE_KEY',
    throwErrorOnFail: false,
    defaultValue: undefined,
    user,
  });

  const blobStorageClient: BlobStorage = new AzureBlobStorage(
    getEnvVariable({ name: 'AZURE_BLOB_STORAGE_NAME', user }),
    storageKey,
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
  const mimeType = lookup(
    blobLocation.split('.')[blobLocation.split('.').length - 1],
  );

  let base64String: string;
  if (blobType === 'images') {
    base64String = blob.toString();
  } else {
    base64String = blob.toString('base64');
  }

  if (base64String.startsWith('data:')) {
    /* pass */
  } else if (mimeType) {
    const base64Content =
      base64String.split('base64')[base64String.split('base64').length - 1];
    base64String = `data:${mimeType};base64,${base64Content}`;
  } else {
    throw new Error(`Couldn't pull mime type: ${blobLocation}`);
  }

  return base64String;
};

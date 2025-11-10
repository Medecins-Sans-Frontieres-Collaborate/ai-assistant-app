import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { AzureBlobStorage } from '@/lib/utils/server/blob';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { DequeuedMessageItem } from '@azure/storage-queue';
import { v4 as uuidv4 } from 'uuid';

// Allowed queue categories for security
const ALLOWED_QUEUE_CATEGORIES = ['transcription', 'general'] as const;
type QueueCategory = (typeof ALLOWED_QUEUE_CATEGORIES)[number];

// Azure Queue Storage limits
const MAX_PEEK_MESSAGES = 32;
const MAX_RECEIVE_MESSAGES = 32;
const MAX_PAGINATION_ATTEMPTS = 100; // Prevent infinite loops (32 * 100 = 3200 max messages)

async function initializeBlobStorage(req: NextRequest) {
  const session: Session | null = await auth();
  if (!session) throw new Error('Failed to pull session!');

  const user = session.user;

  const storageAccountName = env.AZURE_BLOB_STORAGE_NAME;
  const storageAccountAccessKey = env.AZURE_BLOB_STORAGE_KEY; // Optional - uses Entra ID if not set
  const containerName = env.AZURE_BLOB_STORAGE_CONTAINER || 'messages';

  if (!storageAccountName) {
    throw new Error('Storage account name is not set.');
  }

  return {
    azureBlobStorage: new AzureBlobStorage(
      storageAccountName,
      storageAccountAccessKey,
      containerName,
      user,
    ),
    user,
  };
}

/*
 ** GET request:
 * - messageId: string - unique identifier for the message
 * - category: string / enum - category name (queue name)
 *
 * Returns the message's position in the queue and the original message
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    const messageId = searchParams.get('messageId');
    const category = searchParams.get('category');

    if (!messageId || !category) {
      return NextResponse.json(
        { error: 'Missing messageId or category' },
        { status: 400 },
      );
    }

    // Validate queue category against whitelist
    if (
      !ALLOWED_QUEUE_CATEGORIES.includes(
        category.toLowerCase() as QueueCategory,
      )
    ) {
      return NextResponse.json(
        {
          error: 'Invalid queue category',
          allowedCategories: ALLOWED_QUEUE_CATEGORIES,
        },
        { status: 400 },
      );
    }

    const { azureBlobStorage, user } = await initializeBlobStorage(req);
    const queueName = category.toLowerCase();
    const queueClient = azureBlobStorage.getQueueClient(queueName);

    // Peeking messages with pagination to handle queues with >32 messages
    let position = -1;
    let originalMessage: any = null;
    let totalPeeked = 0;

    for (let attempt = 0; attempt < MAX_PAGINATION_ATTEMPTS; attempt++) {
      const peekedMessages = await queueClient.peekMessages({
        numberOfMessages: MAX_PEEK_MESSAGES,
      });

      const messages = peekedMessages.peekedMessageItems;

      if (messages.length === 0) {
        // No more messages in queue
        break;
      }

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const messageContent = JSON.parse(base64Decode(message.messageText));

        if (messageContent.messageId === messageId) {
          if (messageContent.userId !== user.id) {
            return NextResponse.json(
              {
                message:
                  'Forbidden: this message is not marked with your user identifier.',
              },
              { status: 403 },
            );
          }
          position = totalPeeked + i + 1; // Positions start at 1
          originalMessage = messageContent;
          break;
        }
      }

      if (position !== -1) {
        // Found the message
        break;
      }

      totalPeeked += messages.length;

      // If we got fewer than MAX_PEEK_MESSAGES, we've reached the end
      if (messages.length < MAX_PEEK_MESSAGES) {
        break;
      }
    }

    if (position === -1) {
      return NextResponse.json(
        {
          error: `Message not found in queue (searched ${totalPeeked} messages)`,
        },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { position, message: originalMessage.message },
      { status: 200 },
    );
  } catch (error: any) {
    console.error(error);
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 },
    );
  }
}

/*
 ** POST request:
 * - message: string | arbitrary object - the thing to add to the queue
 * - category: string / enum - category name (queue name)
 *
 * The message will contain a blobPath field, but we don't interact directly with blobs
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { azureBlobStorage, user } = await initializeBlobStorage(req);

    const body = await req.json();
    const messageContent = body.message;
    const category = body.category;

    if (!messageContent || !category) {
      return NextResponse.json(
        { error: 'Missing message or category' },
        { status: 400 },
      );
    }

    // Validate queue category against whitelist
    if (!ALLOWED_QUEUE_CATEGORIES.includes(category.toLowerCase())) {
      return NextResponse.json(
        {
          error: 'Invalid queue category',
          allowedCategories: ALLOWED_QUEUE_CATEGORIES,
        },
        { status: 400 },
      );
    }

    const queueName = category.toLowerCase();

    // Ensure the queue exists
    const queueClient = azureBlobStorage.getQueueClient(queueName);
    const exists = await queueClient.exists();
    if (!exists) {
      await azureBlobStorage.createQueue(queueName);
    }

    const messageId = uuidv4();

    // Include messageId and userId in the message content
    const message = {
      messageId,
      userId: user.id,
      message: messageContent,
    };

    const messageText = base64Encode(JSON.stringify(message));

    const response = await azureBlobStorage.addMessage(queueName, messageText);

    return NextResponse.json(
      {
        messageId: response.messageId,
        insertedOn: response.insertedOn,
        expiresOn: response.expiresOn,
      },
      { status: 201 },
    );
  } catch (error: any) {
    console.error(error);
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 },
    );
  }
}

/*
 ** PATCH request:
 * - messageId: string - unique identifier for the message
 * - message: string | arbitrary object - updated message content
 * - category: string / enum - category name (queue name)
 *
 * Updates the existing message in the queue
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const { azureBlobStorage, user } = await initializeBlobStorage(req);

    const body = await req.json();
    const messageId = body.messageId;
    const category = body.category;
    const newMessageContent = body.message;

    if (!messageId || !category || !newMessageContent) {
      return NextResponse.json(
        { error: 'Missing messageId, category, or message' },
        { status: 400 },
      );
    }

    // Validate queue category against whitelist
    if (
      !ALLOWED_QUEUE_CATEGORIES.includes(
        category.toLowerCase() as QueueCategory,
      )
    ) {
      return NextResponse.json(
        {
          error: 'Invalid queue category',
          allowedCategories: ALLOWED_QUEUE_CATEGORIES,
        },
        { status: 400 },
      );
    }

    const queueName = category.toLowerCase();
    const queueClient = azureBlobStorage.getQueueClient(queueName);

    // Receive messages with pagination to handle queues with >32 messages
    let targetMessage: DequeuedMessageItem | null = null;
    let totalReceived = 0;

    for (let attempt = 0; attempt < MAX_PAGINATION_ATTEMPTS; attempt++) {
      const receiveResponse = await queueClient.receiveMessages({
        numberOfMessages: MAX_RECEIVE_MESSAGES,
        visibilityTimeout: 30,
      });

      const messages = receiveResponse.receivedMessageItems;

      if (messages.length === 0) {
        // No more messages in queue
        break;
      }

      for (const message of messages) {
        const messageContent = JSON.parse(base64Decode(message.messageText));

        if (messageContent.messageId === messageId) {
          // Check if the message belongs to the user
          if (messageContent.userId !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
          }
          targetMessage = message;
          break;
        }
      }

      if (targetMessage) {
        // Found the message
        break;
      }

      totalReceived += messages.length;

      // If we got fewer than MAX_RECEIVE_MESSAGES, we've reached the end
      if (messages.length < MAX_RECEIVE_MESSAGES) {
        break;
      }
    }

    if (!targetMessage) {
      return NextResponse.json(
        {
          error: `Message not found in queue (searched ${totalReceived} messages)`,
        },
        { status: 404 },
      );
    }

    const updatedMessageContent = {
      ...JSON.parse(base64Decode(targetMessage.messageText)),
      message: newMessageContent,
    };

    const updatedMessageText = base64Encode(
      JSON.stringify(updatedMessageContent),
    );

    // Update the message in the queue
    await azureBlobStorage.updateMessage(
      queueName,
      targetMessage.messageId,
      targetMessage.popReceipt,
      updatedMessageText,
    );

    return NextResponse.json(
      { message: 'Message updated successfully' },
      { status: 200 },
    );
  } catch (error: any) {
    console.error(error);
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 },
    );
  }
}

/*
 ** DELETE request:
 * - messageId: string - unique identifier for the message
 * - category: string / enum - category name (queue name)
 *
 * Deletes the message from the queue
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    const messageId = searchParams.get('messageId');
    const category = searchParams.get('category');

    if (!messageId || !category) {
      return NextResponse.json(
        { error: 'Missing messageId or category' },
        { status: 400 },
      );
    }

    // Validate queue category against whitelist
    if (
      !ALLOWED_QUEUE_CATEGORIES.includes(
        category.toLowerCase() as QueueCategory,
      )
    ) {
      return NextResponse.json(
        {
          error: 'Invalid queue category',
          allowedCategories: ALLOWED_QUEUE_CATEGORIES,
        },
        { status: 400 },
      );
    }

    const { azureBlobStorage, user } = await initializeBlobStorage(req);

    const queueName = category.toLowerCase();
    const queueClient = azureBlobStorage.getQueueClient(queueName);

    // Receive messages with pagination to handle queues with >32 messages
    let targetMessage: DequeuedMessageItem | null = null;
    let totalReceived = 0;

    for (let attempt = 0; attempt < MAX_PAGINATION_ATTEMPTS; attempt++) {
      const receiveResponse = await queueClient.receiveMessages({
        numberOfMessages: MAX_RECEIVE_MESSAGES,
        visibilityTimeout: 30,
      });

      const messages = receiveResponse.receivedMessageItems;

      if (messages.length === 0) {
        // No more messages in queue
        break;
      }

      for (const message of messages) {
        const messageContent = JSON.parse(base64Decode(message.messageText));

        if (messageContent.messageId === messageId) {
          // Check if the message belongs to the user
          if (messageContent.userId !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
          }
          targetMessage = message;
          break;
        }
      }

      if (targetMessage) {
        // Found the message
        break;
      }

      totalReceived += messages.length;

      // If we got fewer than MAX_RECEIVE_MESSAGES, we've reached the end
      if (messages.length < MAX_RECEIVE_MESSAGES) {
        break;
      }
    }

    if (!targetMessage) {
      return NextResponse.json(
        {
          error: `Message not found in queue (searched ${totalReceived} messages)`,
        },
        { status: 404 },
      );
    }

    await azureBlobStorage.deleteMessage(
      queueName,
      targetMessage.messageId,
      targetMessage.popReceipt,
    );

    return NextResponse.json(
      { message: 'Message deleted successfully' },
      { status: 200 },
    );
  } catch (error: any) {
    console.error(error);
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 },
    );
  }
}

function base64Encode(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

function base64Decode(encodedText: string): string {
  return Buffer.from(encodedText, 'base64').toString('utf-8');
}

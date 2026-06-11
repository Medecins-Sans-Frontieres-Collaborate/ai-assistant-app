import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { DequeuedMessageItem, QueueClient } from '@azure/storage-queue';
import { v4 as uuidv4 } from 'uuid';

// Allowed queue categories for security
const ALLOWED_QUEUE_CATEGORIES = ['transcription', 'general'] as const;
type QueueCategory = (typeof ALLOWED_QUEUE_CATEGORIES)[number];

// Azure Queue Storage limits
const MAX_PEEK_MESSAGES = 32;
const MAX_RECEIVE_MESSAGES = 32;
const MAX_PAGINATION_ATTEMPTS = 100; // Prevent infinite loops (32 * 100 = 3200 max messages)

/** Parsed shape of the queue messages this route writes. */
interface QueueMessageContent {
  messageId?: string;
  userId?: string;
  message?: unknown;
}

/**
 * Parses a queue message's base64 JSON envelope. Returns null for messages
 * this route didn't write (foreign producers, corrupt payloads) so callers
 * skip them instead of throwing a 500 for the whole request.
 */
function tryParseMessage(messageText: string): QueueMessageContent | null {
  try {
    const parsed = JSON.parse(base64Decode(messageText));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as QueueMessageContent)
      : null;
  } catch {
    return null;
  }
}

/** Validates the category param and resolves it to a queue name. */
function resolveQueueName(category: unknown): QueueCategory | null {
  if (typeof category !== 'string') return null;
  const queueName = category.toLowerCase() as QueueCategory;
  return ALLOWED_QUEUE_CATEGORIES.includes(queueName) ? queueName : null;
}

/** Result of searching the queue for a specific message via receive. */
interface ReceiveSearchResult {
  /** The dequeued target message (invisible to other consumers), or null. */
  target: DequeuedMessageItem | null;
  /** True when the message was found but belongs to another user. */
  forbidden: boolean;
  /** How many messages were scanned before concluding. */
  scanned: number;
}

/**
 * Finds a message by envelope messageId using receiveMessages pagination
 * (receive, unlike peek, does advance through the queue).
 *
 * receiveMessages makes every returned message invisible for the visibility
 * timeout, so every message we are NOT acting on is restored to visible
 * before this returns — otherwise a deep scan would stall real consumers
 * for the full timeout. A found-but-foreign target is restored too.
 */
async function findQueuedMessage(
  queueClient: QueueClient,
  messageId: string,
  userId: string | undefined,
): Promise<ReceiveSearchResult> {
  let target: DequeuedMessageItem | null = null;
  let forbidden = false;
  let scanned = 0;
  const toRestore: DequeuedMessageItem[] = [];

  try {
    for (let attempt = 0; attempt < MAX_PAGINATION_ATTEMPTS; attempt++) {
      const receiveResponse = await queueClient.receiveMessages({
        numberOfMessages: MAX_RECEIVE_MESSAGES,
        visibilityTimeout: 30,
      });
      const messages = receiveResponse.receivedMessageItems;
      if (messages.length === 0) break;

      for (const message of messages) {
        scanned++;
        const content = tryParseMessage(message.messageText);
        if (!target && !forbidden && content?.messageId === messageId) {
          if (content.userId !== userId) {
            forbidden = true;
            toRestore.push(message);
          } else {
            target = message;
          }
        } else {
          toRestore.push(message);
        }
      }

      if (target || forbidden) break;
      if (messages.length < MAX_RECEIVE_MESSAGES) break;
    }
  } finally {
    const outcomes = await Promise.allSettled(
      toRestore.map((m) =>
        queueClient.updateMessage(m.messageId, m.popReceipt, m.messageText, 0),
      ),
    );
    const failed = outcomes.filter((o) => o.status === 'rejected').length;
    if (failed > 0) {
      console.warn(
        `[TranscriptionQueue] Failed to restore visibility for ${failed}/${toRestore.length} scanned message(s); they become visible again when the 30s timeout lapses`,
      );
    }
  }

  return { target, forbidden, scanned };
}

async function initializeBlobStorage(req: NextRequest) {
  const session: Session | null = await auth();
  // Message must be exactly 'Unauthorized' — the route catch blocks map it
  // to a 401 (anything else becomes a 500).
  if (!session) throw new Error('Unauthorized');

  const user = session.user;

  const storageAccountName = env.AZURE_BLOB_STORAGE_NAME;
  const containerName = env.AZURE_BLOB_STORAGE_CONTAINER || 'messages';

  if (!storageAccountName) {
    throw new Error('Storage account name is not set.');
  }

  return {
    azureBlobStorage: new AzureBlobStorage(
      storageAccountName,
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
    const queueName = resolveQueueName(category);
    if (!queueName) {
      return NextResponse.json(
        {
          error: 'Invalid queue category',
          allowedCategories: ALLOWED_QUEUE_CATEGORIES,
        },
        { status: 400 },
      );
    }

    const { azureBlobStorage, user } = await initializeBlobStorage(req);
    const queueClient = azureBlobStorage.getQueueClient(queueName);

    // Azure's peekMessages has no pagination cursor — repeated peeks return
    // the same front-of-queue messages, so "paging" with peek just re-reads
    // the first page forever. Search the deepest single peek the API allows
    // and say so explicitly when the message is beyond it.
    const peekedMessages = await queueClient.peekMessages({
      numberOfMessages: MAX_PEEK_MESSAGES,
    });
    const messages = peekedMessages.peekedMessageItems;

    let position = -1;
    let originalMessage: QueueMessageContent | null = null;

    for (let i = 0; i < messages.length; i++) {
      const messageContent = tryParseMessage(messages[i].messageText);
      if (!messageContent) continue;

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
        position = i + 1; // Positions start at 1
        originalMessage = messageContent;
        break;
      }
    }

    if (position === -1 || !originalMessage) {
      return NextResponse.json(
        {
          error: `Message not found among the first ${MAX_PEEK_MESSAGES} queued messages`,
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

    // Validate queue category against whitelist (also rejects non-string
    // payloads, which previously threw on .toLowerCase() and surfaced as 500)
    const queueName = resolveQueueName(category);
    if (!queueName) {
      return NextResponse.json(
        {
          error: 'Invalid queue category',
          allowedCategories: ALLOWED_QUEUE_CATEGORIES,
        },
        { status: 400 },
      );
    }

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
    const queueName = resolveQueueName(category);
    if (!queueName) {
      return NextResponse.json(
        {
          error: 'Invalid queue category',
          allowedCategories: ALLOWED_QUEUE_CATEGORIES,
        },
        { status: 400 },
      );
    }

    const queueClient = azureBlobStorage.getQueueClient(queueName);

    // Receive messages with pagination; every non-target message scanned is
    // restored to visible by findQueuedMessage.
    const {
      target: targetMessage,
      forbidden,
      scanned,
    } = await findQueuedMessage(queueClient, messageId, user.id);

    if (forbidden) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (!targetMessage) {
      return NextResponse.json(
        {
          error: `Message not found in queue (searched ${scanned} messages)`,
        },
        { status: 404 },
      );
    }

    const updatedMessageContent = {
      ...(tryParseMessage(targetMessage.messageText) ?? {}),
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
    const queueName = resolveQueueName(category);
    if (!queueName) {
      return NextResponse.json(
        {
          error: 'Invalid queue category',
          allowedCategories: ALLOWED_QUEUE_CATEGORIES,
        },
        { status: 400 },
      );
    }

    const { azureBlobStorage, user } = await initializeBlobStorage(req);
    const queueClient = azureBlobStorage.getQueueClient(queueName);

    // Receive messages with pagination; every non-target message scanned is
    // restored to visible by findQueuedMessage.
    const {
      target: targetMessage,
      forbidden,
      scanned,
    } = await findQueuedMessage(queueClient, messageId, user.id);

    if (forbidden) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (!targetMessage) {
      return NextResponse.json(
        {
          error: `Message not found in queue (searched ${scanned} messages)`,
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

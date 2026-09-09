/**
 * §4 output tie-in: create Microsoft To Do tasks from a user-confirmed
 * batch (action items extracted from a meeting transcript or any assistant
 * response). Always explicit: the client shows the exact task list and the
 * user confirms before this route is called — model output never triggers
 * writes on its own.
 *
 * POST /api/m365/todo  { tasks: string[] }
 *
 * Tasks land in a dedicated "AI Assistant" To Do list (created on first
 * use), so nothing mixes into the user's own lists uninvited.
 */
import { NextRequest } from 'next/server';

import { graphJson, m365ErrorResponse } from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const SCOPES = ['Tasks.ReadWrite'];
const LIST_NAME = 'AI Assistant';
const MAX_TASKS = 25;
const MAX_TASK_LENGTH = 300;

interface TodoList {
  id?: string;
  displayName?: string;
}

async function ensureTaskList(req: NextRequest): Promise<string> {
  const escaped = LIST_NAME.replace(/'/g, "''");
  const existing = await graphJson<{ value?: TodoList[] }>(
    req,
    SCOPES,
    `/me/todo/lists?$filter=displayName%20eq%20'${encodeURIComponent(escaped)}'`,
  );
  const found = existing.value?.find((list) => list.id);
  if (found?.id) return found.id;

  const created = await graphJson<TodoList>(req, SCOPES, '/me/todo/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: LIST_NAME }),
  });
  if (!created.id) {
    throw new Error('To Do list creation returned no id');
  }
  return created.id;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  let body: { tasks?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequestResponse('Expected a JSON body');
  }
  if (
    !Array.isArray(body.tasks) ||
    body.tasks.length === 0 ||
    !body.tasks.every((task) => typeof task === 'string' && task.trim())
  ) {
    return badRequestResponse('tasks must be a non-empty array of strings');
  }
  if (body.tasks.length > MAX_TASKS) {
    return badRequestResponse(`At most ${MAX_TASKS} tasks per batch`);
  }

  const titles = body.tasks.map((task) =>
    (task as string).trim().slice(0, MAX_TASK_LENGTH),
  );

  try {
    const listId = await ensureTaskList(req);
    // Sequential, not parallel: To Do throttles aggressively and a batch is
    // at most 25 small POSTs.
    let created = 0;
    for (const title of titles) {
      await graphJson(
        req,
        SCOPES,
        `/me/todo/lists/${encodeURIComponent(listId)}/tasks`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        },
      );
      created += 1;
    }
    return successResponse({ created, listName: LIST_NAME });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}

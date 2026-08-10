/**
 * Microsoft To Do tools (fourth pass B2): tasks_list, tasks_create.
 * tasks_create mirrors app/api/m365/todo/route.ts — same default list name,
 * ensure-list-then-sequential-create semantics, same caps — because the
 * pass-3 meetings action-item sink and this tool must land tasks in the
 * same place. graphApi is lazy-imported (see groupMembership.ts).
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  M365ToolInputError,
  catalogScopes,
  escapeODataLiteral,
  formatGraphDateTime,
  optionalString,
  truncateText,
} from '@/lib/services/m365/tools/shared';

// Mirrors app/api/m365/todo/route.ts.
const DEFAULT_LIST_NAME = 'AI Assistant';
const MAX_TASKS = 25;
const MAX_TASK_LENGTH = 300;
const TASKS_PER_LIST = 25;
const MAX_LISTS_QUERIED = 10;

interface TodoList {
  id?: string;
  displayName?: string;
}

interface TodoTask {
  id?: string;
  title?: string;
  status?: string;
  dueDateTime?: { dateTime?: string };
}

function renderTask(task: TodoTask): string {
  const due = task.dueDateTime?.dateTime
    ? ` (due ${formatGraphDateTime(task.dueDateTime.dateTime).slice(0, 10)})`
    : '';
  return `- ${task.title?.trim() || '(untitled)'}${due}`;
}

export async function tasksList(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const listName = optionalString(args, 'listName');
  const scopes = catalogScopes('tasks_list');
  const { graphJson } = await import('@/lib/services/m365/graphApi');

  const listsData = await graphJson<{ value?: TodoList[] }>(
    req,
    scopes,
    '/me/todo/lists?$top=50',
  );
  const allLists = (listsData.value ?? []).filter(
    (list): list is TodoList & { id: string } => !!list.id,
  );

  const matching = listName
    ? allLists.filter(
        (list) =>
          (list.displayName ?? '').toLowerCase() === listName.toLowerCase(),
      )
    : allLists;
  if (matching.length === 0) {
    const names = allLists
      .map((list) => list.displayName)
      .filter(Boolean)
      .join(', ');
    return listName
      ? `No To Do list named "${listName}". Available lists: ${names || 'none'}.`
      : 'No To Do lists found.';
  }

  const queried = matching.slice(0, MAX_LISTS_QUERIED);
  const sections: string[] = [];
  for (const list of queried) {
    const base = `/me/todo/lists/${encodeURIComponent(list.id)}/tasks`;
    let tasks: TodoTask[];
    let serverFiltered = true;
    try {
      const data = await graphJson<{ value?: TodoTask[] }>(
        req,
        scopes,
        `${base}?$filter=${encodeURIComponent("status ne 'completed'")}&$top=${TASKS_PER_LIST}`,
      );
      tasks = data.value ?? [];
    } catch {
      // Some tenants reject $filter on todo tasks — fetch and filter here.
      serverFiltered = false;
      const data = await graphJson<{ value?: TodoTask[] }>(
        req,
        scopes,
        `${base}?$top=50`,
      );
      tasks = data.value ?? [];
    }
    const open = serverFiltered
      ? tasks
      : tasks.filter((task) => task.status !== 'completed');
    const capped = open.slice(0, TASKS_PER_LIST);
    const suffix =
      open.length > capped.length
        ? ` (showing ${capped.length} of ${open.length})`
        : '';
    sections.push(
      [
        `${list.displayName ?? 'Untitled list'} — ${open.length} open task(s)${suffix}:`,
        ...(capped.length > 0 ? capped.map(renderTask) : ['- (no open tasks)']),
      ].join('\n'),
    );
  }
  if (matching.length > queried.length) {
    sections.push(`(showing ${queried.length} of ${matching.length} lists)`);
  }
  return sections.join('\n\n');
}

async function ensureTaskList(
  req: NextRequest,
  scopes: string[],
  listName: string,
): Promise<string> {
  const { graphJson } = await import('@/lib/services/m365/graphApi');
  const escaped = escapeODataLiteral(listName);
  const existing = await graphJson<{ value?: TodoList[] }>(
    req,
    scopes,
    `/me/todo/lists?$filter=${encodeURIComponent(`displayName eq '${escaped}'`)}`,
  );
  const found = existing.value?.find((list) => list.id);
  if (found?.id) return found.id;

  const created = await graphJson<TodoList>(req, scopes, '/me/todo/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: listName }),
  });
  if (!created.id) {
    throw new Error('To Do list creation returned no id');
  }
  return created.id;
}

export async function tasksCreate(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const rawTasks = args.tasks;
  if (
    !Array.isArray(rawTasks) ||
    rawTasks.length === 0 ||
    !rawTasks.every((task) => typeof task === 'string' && task.trim())
  ) {
    throw new M365ToolInputError(
      'tasks must be a non-empty array of task titles',
    );
  }
  if (rawTasks.length > MAX_TASKS) {
    throw new M365ToolInputError(`At most ${MAX_TASKS} tasks per call`);
  }
  const listName = optionalString(args, 'listName') ?? DEFAULT_LIST_NAME;
  const titles = (rawTasks as string[]).map((task) =>
    task.trim().slice(0, MAX_TASK_LENGTH),
  );

  const scopes = catalogScopes('tasks_create');
  const { graphJson } = await import('@/lib/services/m365/graphApi');
  const listId = await ensureTaskList(req, scopes, listName);

  // Sequential, not parallel: To Do throttles aggressively and a batch is
  // at most 25 small POSTs (mirrors the todo route).
  let created = 0;
  try {
    for (const title of titles) {
      await graphJson(
        req,
        scopes,
        `/me/todo/lists/${encodeURIComponent(listId)}/tasks`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        },
      );
      created += 1;
    }
  } catch (error) {
    if (created === 0) throw error;
    // Partial batches surface what DID land — a wholesale isError would
    // make the model retry tasks that already exist.
    const reason =
      error instanceof Error ? truncateText(error.message, 120) : 'error';
    return (
      `Created ${created} of ${titles.length} task(s) in "${listName}" ` +
      `before a failure (${reason}). Do not re-create the first ${created}.`
    );
  }
  return `Created ${created} task(s) in "${listName}".`;
}

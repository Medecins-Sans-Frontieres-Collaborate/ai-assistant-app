'use client';

import { IconListCheck, IconLoader2 } from '@tabler/icons-react';
import { FC, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { createTodoTasks } from '@/client/services/m365/m365Client';

import Modal from '@/components/UI/Modal';

interface M365TodoTasksModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The assistant message text to extract action items from. */
  content: string;
}

const MAX_TASKS = 25;

/**
 * Pulls likely action items out of assistant text: bullet / checkbox /
 * numbered lines, markdown chrome stripped. Extraction is deliberately dumb
 * and transparent — the user sees and confirms the exact list before
 * anything is written (the write-confirmation policy for model output).
 */
export function extractTaskCandidates(content: string): string[] {
  const tasks: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const match = line.match(
      /^(?:[-*•]\s*(?:\[[ xX]?\]\s*)?|\d{1,2}[.)]\s+)(.+)$/,
    );
    if (!match) continue;
    const text = match[1]
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim();
    if (text.length < 3) continue;
    tasks.push(text.slice(0, 300));
    if (tasks.length >= MAX_TASKS) break;
  }
  return tasks;
}

/**
 * §4 output tie-in: user-confirmed batch of action items → Microsoft To Do
 * ("AI Assistant" list). The confirm step is the write gate — unchecked
 * items are never sent, and nothing happens without the button press.
 */
const M365TodoTasksModal: FC<M365TodoTasksModalProps> = ({
  isOpen,
  onClose,
  content,
}) => {
  const t = useTranslations('m365.todo');
  const candidates = useMemo(() => extractTaskCandidates(content), [content]);
  const [selected, setSelected] = useState<boolean[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    if (isOpen) setSelected(candidates.map(() => true));
  }, [isOpen, candidates]);

  const selectedCount = selected.filter(Boolean).length;

  const handleCreate = async () => {
    const tasks = candidates.filter((_, index) => selected[index]);
    if (tasks.length === 0) return;
    setIsCreating(true);
    try {
      const result = await createTodoTasks(tasks);
      toast.success(
        t('created', { count: result.created, list: result.listName }),
        { duration: 6000 },
      );
      onClose();
    } catch {
      toast.error(t('failed'));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('title')}
      icon={<IconListCheck size={20} />}
      size="md"
    >
      <div className="flex max-h-[420px] flex-col gap-3">
        {candidates.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('noTasksFound')}
          </p>
        ) : (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('hint')}
            </p>
            <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {candidates.map((task, index) => (
                <li key={`${index}-${task.slice(0, 20)}`}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-neutral-800">
                    <input
                      type="checkbox"
                      checked={selected[index] ?? false}
                      onChange={(event) =>
                        setSelected((prev) =>
                          prev.map((value, i) =>
                            i === index ? event.target.checked : value,
                          ),
                        )
                      }
                      className="mt-0.5 flex-shrink-0"
                    />
                    <span>{task}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-700">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={isCreating || selectedCount === 0}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40"
              >
                {isCreating && (
                  <IconLoader2 size={14} className="animate-spin" />
                )}
                {t('createButton', { count: selectedCount })}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default M365TodoTasksModal;

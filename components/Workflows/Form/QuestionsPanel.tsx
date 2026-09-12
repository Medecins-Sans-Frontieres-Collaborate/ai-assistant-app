'use client';

import { IconMessageQuestion } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { openQuestions } from '@/lib/services/workflows/form/questions';

import { FormDocument } from '@/types/formFill';

interface QuestionsPanelProps {
  document: FormDocument;
  busy: boolean;
  onAnswer: (questionId: string, answer: string) => void;
  onSkip: (questionId: string) => void;
  onNotApplicable: (questionId: string, fieldIds: string[]) => void;
}

/**
 * The assistant's open questions (docs/DOCUMENT_FILL_ASSESSMENT.md §6a):
 * general ones about the subject while coverage is low, targeted ones
 * naming fields afterwards. Answering records a note source and runs an
 * incremental fill for the question's fields; a question retires on its
 * own once its fields are addressed.
 */
export function QuestionsPanel({
  document,
  busy,
  onAnswer,
  onSkip,
  onNotApplicable,
}: QuestionsPanelProps) {
  const t = useTranslations('workflows.form');
  const questions = openQuestions(document);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const labelOf = (id: string) =>
    document.template.fields.find((f) => f.id === id)?.label ?? id;

  if (questions.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
        {t('questionsEmpty')}
      </p>
    );
  }

  return (
    <ul className="space-y-2 px-3 py-2">
      {questions.map((question) => {
        const draft = drafts[question.id] ?? '';
        return (
          <li
            key={question.id}
            className="rounded-lg border border-blue-200 bg-blue-50/40 p-2.5 dark:border-blue-900/40 dark:bg-blue-900/10"
          >
            <p className="flex items-start gap-1.5 text-sm text-gray-900 dark:text-gray-100">
              <IconMessageQuestion
                size={15}
                aria-hidden
                className="mt-0.5 shrink-0 text-blue-600"
              />
              <span>{question.text}</span>
            </p>
            <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
              {question.mode === 'general' || question.fieldIds.length === 0
                ? t('questionGeneral')
                : t('questionTargeted', {
                    fields: question.fieldIds.map(labelOf).join(', '),
                  })}
            </p>
            <textarea
              value={draft}
              rows={2}
              disabled={busy}
              onChange={(e) =>
                setDrafts({ ...drafts, [question.id]: e.target.value })
              }
              placeholder={t('answerPlaceholder')}
              className="mt-1.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100"
            />
            <div className="mt-1 flex items-center gap-1">
              <button
                type="button"
                disabled={busy || !draft.trim()}
                onClick={() => {
                  onAnswer(question.id, draft.trim());
                  setDrafts({ ...drafts, [question.id]: '' });
                }}
                className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-30"
              >
                {t('answer')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onSkip(question.id)}
                className="rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
              >
                {t('skip')}
              </button>
              {question.fieldIds.length > 0 && question.mode === 'targeted' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onNotApplicable(question.id, question.fieldIds)
                  }
                  className="ms-auto rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                >
                  {t('markNa')}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

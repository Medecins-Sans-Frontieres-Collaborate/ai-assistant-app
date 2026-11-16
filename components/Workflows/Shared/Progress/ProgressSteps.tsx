'use client';

import { IconCheck } from '@tabler/icons-react';

import { ProgressStepStatus } from '@/lib/utils/shared/translation/runProgress';

/** One step as shown: its state plus the label to print under it. */
export interface LabelledProgressStep {
  id: string;
  status: ProgressStepStatus;
  label: string;
}

interface ProgressStepsProps {
  steps: LabelledProgressStep[];
  /** Accessible name of the whole indicator, e.g. "Translation progress". */
  label: string;
}

const MARKER_CLASS: Record<ProgressStepStatus, string> = {
  done: 'border-green-600 bg-green-600 text-white dark:border-green-500 dark:bg-green-500 dark:text-gray-900',
  active:
    'border-blue-600 border-t-transparent motion-safe:animate-spin dark:border-blue-400 dark:border-t-transparent',
  upcoming: 'border-gray-300 dark:border-gray-600',
};

const LABEL_CLASS: Record<ProgressStepStatus, string> = {
  done: 'text-gray-600 dark:text-gray-400',
  active: 'font-medium text-gray-900 dark:text-gray-100',
  upcoming: 'text-gray-500 dark:text-gray-500',
};

/**
 * Named steps of a multi-step operation: finished steps are checked, the
 * one in progress spins, the rest wait. Used wherever the workspace would
 * otherwise show a bare spinner for work that has distinct phases.
 *
 * The active step carries `aria-current="step"`, so assistive technology
 * can tell where the operation is without the colors.
 */
export function ProgressSteps({ steps, label }: ProgressStepsProps) {
  return (
    <ol
      aria-label={label}
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
    >
      {steps.map((step, index) => (
        <li
          key={step.id}
          aria-current={step.status === 'active' ? 'step' : undefined}
          data-status={step.status}
          className="flex items-center gap-2"
        >
          {index > 0 && (
            <span
              aria-hidden
              className={`h-px w-6 ${
                step.status === 'upcoming'
                  ? 'bg-gray-300 dark:bg-gray-600'
                  : 'bg-green-600 dark:bg-green-500'
              }`}
            />
          )}
          <span
            aria-hidden
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${MARKER_CLASS[step.status]}`}
          >
            {step.status === 'done' && <IconCheck size={10} stroke={3} />}
          </span>
          <span className={`text-xs ${LABEL_CLASS[step.status]}`}>
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

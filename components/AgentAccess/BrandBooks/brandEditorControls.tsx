'use client';

import { ReactNode, useId, useState } from 'react';

import { isHexColor, normalizeHex } from '@/lib/utils/shared/brand/brandColor';

/**
 * Small inputs the brand book editor is built from. Each one that turns
 * text into a value (a list, a colour, a number) keeps the text the admin
 * is typing locally and commits on blur, so a half-typed "#0f7" or a
 * trailing comma is never rewritten under their cursor.
 */

export const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-blue-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-600 aria-[invalid=true]:border-red-500 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100';
export const quietButtonClass =
  'inline-flex min-h-[32px] items-center gap-1 rounded-md px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';
export const removeButtonClass =
  'inline-flex min-h-[32px] items-center rounded-md px-2 text-xs text-red-600 hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-600 dark:text-red-400 dark:hover:bg-red-900/20';

/** A labelled control; the label names the input for screen readers. */
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
      >
        {label}
      </label>
      {children(id)}
      {hint && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-500">{hint}</p>
      )}
    </div>
  );
}

/**
 * Text that follows `value` until the admin edits it, then commits on
 * blur. A commit that returns false refuses the text, which then stays in
 * the box for the admin to correct.
 */
function useCommittedText(
  value: string,
  commit: (text: string) => boolean | void,
) {
  // The admin's text while they edit; null shows `value`.
  const [editing, setEditing] = useState<string | null>(null);
  return {
    props: {
      value: editing ?? value,
      onChange: (event: { target: { value: string } }) => {
        setEditing(event.target.value);
      },
      onBlur: () => {
        if (editing === null) return;
        if (commit(editing) !== false) setEditing(null);
      },
    },
    /** Drops the admin's text, showing `value` again. */
    reset: () => setEditing(null),
  };
}

/** A comma-separated list of strings. */
export function ListInput({
  id,
  values,
  onChange,
  placeholder,
}: {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const { props } = useCommittedText(values.join(', '), (text) =>
    onChange(
      text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  return (
    <input
      id={id}
      type="text"
      className={inputClass}
      placeholder={placeholder}
      {...props}
    />
  );
}

/**
 * A colour as a swatch picker and its hex text. A hex that is not one
 * stays in the box, marked invalid, and is not committed.
 */
export function HexInput({
  id,
  value,
  onChange,
  label,
}: {
  id?: string;
  value: string;
  onChange: (hex: string) => void;
  /** Names the swatch picker, which has no visible label of its own. */
  label: string;
}) {
  const [invalid, setInvalid] = useState(false);
  const { props, reset } = useCommittedText(value, (text) => {
    if (isHexColor(text)) {
      setInvalid(false);
      onChange(normalizeHex(text));
      return true;
    }
    setInvalid(true);
    return false;
  });
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="color"
        aria-label={label}
        className="h-8 w-8 shrink-0 cursor-pointer rounded border border-gray-300 bg-transparent p-0.5 dark:border-gray-700"
        value={isHexColor(value) ? normalizeHex(value) : '#000000'}
        onChange={(event) => {
          setInvalid(false);
          reset();
          onChange(normalizeHex(event.target.value));
        }}
      />
      <input
        id={id}
        type="text"
        spellCheck={false}
        aria-invalid={invalid}
        className={`${inputClass} w-24 font-mono`}
        {...props}
      />
    </span>
  );
}

/**
 * A number within bounds, or empty when `optional` (committed as
 * undefined). Out-of-range text is clamped on commit.
 */
export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  optional = false,
  className = '',
}: {
  id?: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min: number;
  max: number;
  step?: number;
  optional?: boolean;
  className?: string;
}) {
  const { props } = useCommittedText(
    value === undefined ? '' : String(value),
    (text) => {
      const parsed = Number.parseFloat(text);
      if (!text.trim() || Number.isNaN(parsed)) {
        onChange(optional ? undefined : value);
        return;
      }
      onChange(Math.min(max, Math.max(min, parsed)));
    },
  );
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      className={`${inputClass} ${className}`}
      {...props}
    />
  );
}

/** A titled part of the editor, with its own add action. */
export function EditorSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="py-6 first:pt-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2
            id={id}
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

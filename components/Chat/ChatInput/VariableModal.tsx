'use client';

import {
  FC,
  KeyboardEvent,
  ReactNode,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import {
  PromptSegment,
  getVariableDefinitions,
  humanizeVariableName,
  promptSegments,
  variableContext,
} from '@/lib/utils/shared/chat/variables';

import { Prompt } from '@/types/prompt';

import Modal from '@/components/UI/Modal';

interface Props {
  prompt: Prompt;
  /**
   * Called with every variable's value, in the order the prompt first uses
   * them, and the same values by name. An empty value means "use the
   * default" (see replaceVariablesWithMap).
   */
  onSubmit: (
    updatedVariables: string[],
    variableMap: { [key: string]: string },
  ) => void;
  onClose: () => void;
}

/** Rows a value's field grows to before it scrolls. */
const MAX_FIELD_ROWS = 6;

/**
 * Fills in a prompt's variables before it goes into the message box.
 *
 * Each field is named in words ("Example values" for {{example_values}})
 * and shows the sentence of the prompt it sits in, so what to type is
 * clear from the prompt itself. Below the fields, the message as it will
 * read, updated while typing. A variable with a default can be left empty.
 *
 * Keys: Enter moves to the next field and, in the last one, inserts the
 * prompt; Shift+Enter starts a new line; Ctrl/Cmd+Enter inserts from any
 * field; Escape cancels. A missing value is pointed out at its field.
 */
export const VariableModal: FC<Props> = ({ prompt, onSubmit, onClose }) => {
  const t = useTranslations();
  const formId = useId();
  const definitions = useMemo(
    () => getVariableDefinitions(prompt.content),
    [prompt.content],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(
    definitions[0]?.name ?? null,
  );
  const fields = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const firstField = useRef<HTMLTextAreaElement | null>(null);
  const typedSomething = Object.values(values).some((value) => value.trim());

  const setValue = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    if (value.trim()) {
      setMissing((current) => current.filter((other) => other !== name));
    }
  };

  const submit = () => {
    const empty = definitions
      .filter((definition) => !definition.isOptional)
      .map((definition) => definition.name)
      .filter((name) => !values[name]?.trim());
    if (empty.length > 0) {
      setMissing(empty);
      fields.current[empty[0]]?.focus();
      return;
    }
    const variableMap = Object.fromEntries(
      definitions.map((definition) => [
        definition.name,
        values[definition.name] ?? '',
      ]),
    );
    onSubmit(
      definitions.map((definition) => variableMap[definition.name]),
      variableMap,
    );
    onClose();
  };

  const onFieldKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
    index: number,
  ) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    const next = definitions[index + 1];
    if (event.ctrlKey || event.metaKey || !next) submit();
    else fields.current[next.name]?.focus();
  };

  const preview = promptSegments(prompt.content, values);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={prompt.name}
      size="lg"
      initialFocusRef={firstField}
      // Typed values are not thrown away by a stray click beside the dialog.
      preventOutsideClick={typedSomething}
      closeWithButton={false}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          <p className="me-auto text-xs text-gray-500 dark:text-gray-400">
            {t('variableModal.keysHint')}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t('variableModal.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t('variableModal.insert')}
          </button>
        </div>
      }
    >
      {prompt.description && (
        <p className="-mt-2 mb-4 text-sm text-gray-600 dark:text-gray-400">
          {prompt.description}
        </p>
      )}
      <form
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-5"
      >
        {definitions.map((definition, index) => {
          const { name } = definition;
          const fieldId = `${formId}-${name}`;
          const contextId = `${fieldId}-context`;
          const errorId = `${fieldId}-error`;
          const isMissing = missing.includes(name);
          const value = values[name] ?? '';
          return (
            <div key={name} className="flex flex-col gap-1.5">
              <label
                htmlFor={fieldId}
                className="text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                {humanizeVariableName(name)}
                {definition.isOptional && (
                  // A real space, so the name reads "Audience (optional)".
                  <span className="font-normal text-gray-500 dark:text-gray-400">
                    {' '}
                    {t('variableModal.optionalSuffix')}
                  </span>
                )}
              </label>
              <p
                id={contextId}
                className="text-xs leading-relaxed text-gray-500 dark:text-gray-400"
              >
                <PromptText
                  segments={variableContext(prompt.content, name, values)}
                  active={name}
                />
              </p>
              <textarea
                id={fieldId}
                ref={(element) => {
                  fields.current[name] = element;
                  if (index === 0) firstField.current = element;
                }}
                value={value}
                rows={Math.min(
                  MAX_FIELD_ROWS,
                  Math.max(1, value.split('\n').length),
                )}
                placeholder={
                  definition.defaultValue
                    ? t('variableModal.defaultPlaceholder', {
                        defaultValue: definition.defaultValue,
                      })
                    : undefined
                }
                aria-invalid={isMissing || undefined}
                aria-describedby={
                  isMissing ? `${contextId} ${errorId}` : contextId
                }
                onChange={(event) => setValue(name, event.target.value)}
                onFocus={() => setActive(name)}
                onKeyDown={(event) => onFieldKeyDown(event, index)}
                className={`w-full resize-y rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder:text-gray-500 ${
                  isMissing
                    ? 'border-red-500 focus:ring-red-500/30'
                    : 'border-gray-300 focus:border-blue-500 focus:ring-blue-500/20 dark:border-gray-600'
                }`}
              />
              {isMissing && (
                <p
                  id={errorId}
                  role="alert"
                  className="text-xs text-red-600 dark:text-red-400"
                >
                  {t('variableModal.missing')}
                </p>
              )}
            </div>
          );
        })}

        <section aria-labelledby={`${formId}-preview`}>
          <h4
            id={`${formId}-preview`}
            className="mb-1.5 text-xs font-medium text-gray-700 dark:text-gray-300"
          >
            {t('variableModal.preview')}
          </h4>
          <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-gray-50 px-3 py-2 text-sm leading-relaxed text-gray-800 dark:bg-gray-800/60 dark:text-gray-200">
            <PromptText segments={preview} active={active} />
          </div>
        </section>
      </form>
    </Modal>
  );
};

/**
 * Prompt text with its variables marked: the one being filled (`active`)
 * highlighted, a value or default as typed, and a variable still to fill
 * as its name in brackets.
 */
function PromptText({
  segments,
  active,
}: {
  segments: PromptSegment[];
  active: string | null;
}): ReactNode {
  return segments.map((segment, index) => {
    if (segment.kind === 'text') return segment.text;
    const isActive = segment.name === active;
    const shown = segment.missing
      ? `[${humanizeVariableName(segment.name)}]`
      : segment.text;
    const look = isActive
      ? 'rounded bg-blue-100 px-0.5 text-blue-900 dark:bg-blue-900/50 dark:text-blue-100'
      : segment.missing
        ? 'text-gray-500 dark:text-gray-400'
        : segment.usesDefault
          ? 'italic'
          : 'font-medium text-gray-900 dark:text-gray-100';
    return (
      <span key={index} data-variable={segment.name} className={look}>
        {shown}
      </span>
    );
  });
}

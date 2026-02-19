import {
  IconBraces,
  IconCheck,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-react';
import { FC, KeyboardEvent, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  VariableDefinition,
  getVariableDefinitions,
} from '@/lib/utils/shared/chat/variables';

import { Prompt } from '@/types/prompt';

interface Props {
  prompt: Prompt;
  variables: string[];
  onSubmit: (
    updatedVariables: string[],
    variableMap: { [key: string]: string },
  ) => void;
  onClose: () => void;
}

export const VariableModal: FC<Props> = ({
  prompt,
  variables,
  onSubmit,
  onClose,
}) => {
  const t = useTranslations();

  // Get variable definitions with defaults from the prompt content
  const variableDefinitions = getVariableDefinitions(prompt.content);

  const [updatedVariables, setUpdatedVariables] = useState<
    { key: string; value: string; definition: VariableDefinition }[]
  >(
    variableDefinitions.map((varDef) => ({
      key: varDef.name,
      value: '',
      definition: varDef,
    })),
  );

  const modalRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = (index: number, value: string) => {
    setUpdatedVariables((prev) => {
      const updated = [...prev];
      updated[index].value = value;
      return updated;
    });
  };

  const handleSubmit = () => {
    // Only validate required variables (those without defaults)
    const missingRequired = updatedVariables.filter(
      (variable) => !variable.definition.isOptional && variable.value === '',
    );

    if (missingRequired.length > 0) {
      alert(
        `Please fill out all required variables: ${missingRequired.map((v) => v.key).join(', ')}`,
      );
      return;
    }

    // Create a map of variable keys to values
    const variableMap: { [key: string]: string } = {};
    updatedVariables.forEach((variable) => {
      variableMap[variable.key] = variable.value;
    });

    onSubmit(
      updatedVariables.map((variable) => variable.value),
      variableMap,
    );
    onClose();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    window.addEventListener('click', handleOutsideClick);

    return () => {
      window.removeEventListener('click', handleOutsideClick);
    };
  }, [onClose]);

  useEffect(() => {
    if (nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in-fast"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={modalRef}
        className="relative inline-block max-h-[90vh] w-full max-w-lg transform overflow-hidden rounded-xl border border-gray-200 bg-white text-left align-bottom shadow-2xl transition-all dark:border-gray-700 dark:bg-[#212121] sm:my-8 sm:align-middle animate-modal-in"
        role="dialog"
      >
        {/* Header */}
        <div className="relative border-b border-gray-200 bg-blue-50 px-6 py-5 dark:border-gray-700 dark:bg-blue-900/20">
          <button
            onClick={onClose}
            className="absolute right-4 top-4 p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors rounded-lg hover:bg-white/50 dark:hover:bg-black/30"
            aria-label={t('common.close')}
          >
            <IconX size={20} />
          </button>

          <div className="flex items-start gap-3 pr-8">
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                {prompt.name}
              </h3>
              {prompt.description && (
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {prompt.description}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-h-[calc(90vh-220px)] overflow-y-auto px-6 py-5 space-y-5">
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/10 px-3 py-2 rounded-lg border border-blue-100 dark:border-blue-900/30">
            <IconBraces size={16} className="shrink-0" />
            <span>{t('variableModal.fillInstructions')}</span>
          </div>

          {updatedVariables.map((variable, index) => (
            <div key={index} className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <div className="flex h-6 w-6 items-center justify-center rounded bg-gray-100 dark:bg-gray-800 text-xs font-mono text-gray-600 dark:text-gray-400">
                  {index + 1}
                </div>
                <span className="font-mono text-blue-600 dark:text-blue-400">
                  {`{{${variable.key}}}`}
                </span>
                {variable.definition.isOptional ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                    {t('variableModal.optional')}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
                    {t('variableModal.required')}
                  </span>
                )}
              </label>

              {variable.definition.defaultValue && (
                <div className="flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/10 px-2.5 py-1.5 rounded border border-blue-100 dark:border-blue-900/30">
                  <IconInfoCircle size={14} className="shrink-0 mt-0.5" />
                  <span>
                    {t('variableModal.default')}{' '}
                    <span className="font-mono font-medium">
                      {variable.definition.defaultValue}
                    </span>
                  </span>
                </div>
              )}

              <textarea
                ref={index === 0 ? nameInputRef : undefined}
                className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm transition-all placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-[#2a2a2a] dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-blue-400 dark:focus:ring-blue-400/20"
                style={{ resize: 'vertical', minHeight: '80px' }}
                placeholder={
                  variable.definition.defaultValue
                    ? t('variableModal.defaultPlaceholder', {
                        defaultValue: variable.definition.defaultValue,
                      })
                    : t('variableModal.enterValue', { key: variable.key })
                }
                value={variable.value}
                onChange={(e) => handleChange(index, e.target.value)}
                rows={3}
              />
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 bg-gray-50 px-6 py-4 dark:border-gray-700 dark:bg-[#1a1a1a]">
          <div className="flex items-center justify-end gap-3">
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {t('variableModal.cancel')}
              </button>
              <button
                onClick={handleSubmit}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-md transition-all hover:bg-blue-700 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              >
                <IconCheck size={16} />
                <span>{t('variableModal.apply')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

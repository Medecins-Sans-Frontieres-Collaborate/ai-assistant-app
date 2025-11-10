import React, { forwardRef } from 'react';

export interface TextareaInputProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  id?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  disabled?: boolean;
  label?: string;
  labelClassName?: string;
}

export const TextareaInput = forwardRef<
  HTMLTextAreaElement,
  TextareaInputProps
>(
  (
    {
      id,
      value,
      onChange,
      placeholder,
      rows = 6,
      className = '',
      disabled = false,
      label,
      labelClassName = '',
      ...rest
    },
    ref,
  ) => {
    const baseClassName =
      'block w-full px-4 py-3 bg-white dark:bg-[#2D3748] border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none transition-all disabled:opacity-50 disabled:cursor-not-allowed';

    return (
      <div>
        {label && (
          <label
            htmlFor={id}
            className={`block text-sm font-semibold mb-2 text-gray-900 dark:text-white ${labelClassName}`}
          >
            {label}
          </label>
        )}
        <textarea
          id={id}
          ref={ref}
          rows={rows}
          className={`${baseClassName} ${className}`}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          {...rest}
        />
      </div>
    );
  },
);

TextareaInput.displayName = 'TextareaInput';

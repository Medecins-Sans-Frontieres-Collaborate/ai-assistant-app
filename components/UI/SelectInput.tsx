import React from 'react';

export interface SelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

export interface SelectInputProps {
  id?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function SelectInput({
  id,
  value,
  onChange,
  options,
  placeholder,
  className = '',
  disabled = false,
}: SelectInputProps) {
  const baseClassName =
    'flex-1 pl-4 pr-10 py-3 text-base bg-white dark:bg-[#2D3748] border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <select
      id={id}
      className={`${baseClassName} ${className}`}
      value={value}
      onChange={onChange}
      disabled={disabled}
    >
      {placeholder && (
        <option value="" className="text-gray-500 dark:text-gray-400">
          {placeholder}
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.sublabel
            ? `${option.label} (${option.sublabel})`
            : option.label}
        </option>
      ))}
    </select>
  );
}

import React from 'react';

/**
 * Stylized Moonshot AI (Kimi) mark: a crescent moon, monochrome via
 * currentColor (with a teal brand tint) to match the other provider icons in
 * this directory.
 */
export function KimiIcon(props: React.SVGProps<SVGSVGElement>) {
  const { className, ...rest } = props;
  return (
    <svg
      {...rest}
      className={`${className} text-teal-600 dark:text-teal-400`}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M20.7 14.6a.8.8 0 0 0-.9-.3 7.6 7.6 0 0 1-2.4.4A7.8 7.8 0 0 1 9.6 7a7.9 7.9 0 0 1 .4-2.4.8.8 0 0 0-1-1A9.8 9.8 0 0 0 2.6 13a9.4 9.4 0 0 0 9.4 8.4 9.8 9.8 0 0 0 8.9-5.9.8.8 0 0 0-.2-.9z" />
    </svg>
  );
}

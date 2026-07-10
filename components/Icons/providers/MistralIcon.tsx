import React from 'react';

/**
 * Stylized Mistral AI mark: the pixelated "M" drawn on a 9x5 block grid,
 * monochrome via currentColor (with an orange brand tint) to match the other
 * provider icons in this directory.
 */
export function MistralIcon(props: React.SVGProps<SVGSVGElement>) {
  const { className, ...rest } = props;
  return (
    <svg
      {...rest}
      className={`${className} text-orange-500 dark:text-orange-400`}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 9 9"
      fill="currentColor"
    >
      {/* left leg */}
      <rect x="0" y="2" width="1" height="5" />
      {/* right leg */}
      <rect x="8" y="2" width="1" height="5" />
      {/* left diagonal */}
      <rect x="1" y="3" width="1" height="1" />
      <rect x="2" y="4" width="1" height="1" />
      <rect x="3" y="5" width="1" height="1" />
      {/* right diagonal */}
      <rect x="7" y="3" width="1" height="1" />
      <rect x="6" y="4" width="1" height="1" />
      <rect x="5" y="5" width="1" height="1" />
      {/* center meeting block */}
      <rect x="4" y="6" width="1" height="1" />
    </svg>
  );
}

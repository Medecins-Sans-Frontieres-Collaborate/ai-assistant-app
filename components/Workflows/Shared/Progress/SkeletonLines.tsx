'use client';

interface SkeletonLinesProps {
  /** Width of each placeholder line, as a CSS width (e.g. `'60%'`). */
  widths: string[];
  className?: string;
}

/**
 * Placeholder lines for text that is still on its way. Decorative: the
 * surrounding status text is what announces the wait.
 */
export function SkeletonLines({ widths, className }: SkeletonLinesProps) {
  return (
    <div aria-hidden className={`space-y-2 ${className ?? ''}`}>
      {widths.map((width, index) => (
        <div
          key={index}
          style={{ width }}
          className="h-3 rounded bg-gray-200 motion-safe:animate-pulse dark:bg-gray-700"
        />
      ))}
    </div>
  );
}

'use client';

import { IconChevronDown } from '@tabler/icons-react';
import { Suspense, lazy, useState } from 'react';

// Lazy load the MermaidDiagram component (which includes the 66MB mermaid library)
const MermaidDiagram = lazy(() =>
  import('@/components/UI/MermaidDiagram').then((mod) => ({
    default: mod.MermaidDiagram,
  })),
);

interface CollapsibleDiagramProps {
  title: string;
  diagram: string;
  legend: string;
}

export function CollapsibleDiagram({
  title,
  diagram,
  legend,
}: CollapsibleDiagramProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 mb-4 flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <span className="text-sm font-medium text-gray-900 dark:text-white">
          {title}
        </span>
        <IconChevronDown
          size={20}
          className={`text-gray-600 dark:text-gray-400 transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 mb-4 overflow-x-auto">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            <strong>Legend:</strong> {legend}
          </p>
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-400"></div>
                <span className="ml-3 text-sm text-gray-600 dark:text-gray-400">
                  Loading diagram...
                </span>
              </div>
            }
          >
            <MermaidDiagram chart={diagram} className="flex justify-center" />
          </Suspense>
        </div>
      )}
    </>
  );
}

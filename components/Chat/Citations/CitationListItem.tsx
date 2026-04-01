import React from 'react';

import Link from 'next/link';

import { Citation } from '@/types/rag';

interface CitationListItemProps {
  citation: Citation;
}

/**
 * Renders a citation as a compact list row with number, title, domain, and date.
 * Used as an alternative to the card view (CitationItem) for detailed citation viewing.
 */
export const CitationListItem: React.FC<CitationListItemProps> = ({
  citation,
}) => {
  if (!citation.title || !citation.url) {
    return null;
  }

  const processUrl = (
    url: string,
  ): { hostname: string; cleanDomain: string } => {
    try {
      const { hostname } = new URL(url);
      const cleanDomain = hostname.replace(/^www\./, '').split('.')[0];
      return { hostname, cleanDomain };
    } catch (error) {
      console.error('Invalid URL:', url);
      return { hostname: 'Invalid URL', cleanDomain: 'Invalid URL' };
    }
  };

  const { hostname, cleanDomain } = processUrl(citation.url);

  const formatDate = (dateStr: string): string => {
    if (!dateStr || dateStr.trim() === '') return '';
    try {
      return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  };

  const formattedDate = formatDate(citation.date);

  return (
    <Link
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
      title={citation.title}
      className="flex items-center w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-surface-dark-base hover:bg-gray-200 dark:hover:bg-surface-dark border border-transparent hover:border-blue-400/50 dark:hover:border-blue-500/40 transition-all duration-200 no-underline group"
    >
      <span className="flex-shrink-0 w-6 text-xs font-semibold text-blue-600 dark:text-blue-400">
        [{citation.number}]
      </span>

      <span className="flex-grow min-w-0 text-sm text-gray-800 dark:text-white truncate mx-3 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors duration-200">
        {citation.title}
      </span>

      <div className="flex items-center flex-shrink-0 gap-3 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://www.google.com/s2/favicons?domain=${hostname}&size=16`}
            alt={`${hostname} favicon`}
            width={12}
            height={12}
            className="flex-shrink-0"
          />
          <span className="truncate max-w-[80px]">{cleanDomain}</span>
        </div>

        {formattedDate && (
          <>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            <span className="flex-shrink-0">{formattedDate}</span>
          </>
        )}
      </div>
    </Link>
  );
};

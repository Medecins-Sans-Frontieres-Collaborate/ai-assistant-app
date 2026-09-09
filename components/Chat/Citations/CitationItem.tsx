import React from 'react';

import Link from 'next/link';

import { SourceCard } from '@/lib/utils/app/citationDisplay';

export const CitationItem: React.FC<{ citation: SourceCard }> = ({
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

  // Prefer the true publisher for the domain display: aggregator links
  // (news.google.com fallbacks) would otherwise make every card look like
  // the same source and hide source diversity.
  const { hostname, cleanDomain } = processUrl(
    citation.sourceUrl || citation.url,
  );
  const displayName = citation.sourceName || cleanDomain;

  const hasEvidence = !!citation.evidence?.length;
  const hasQuoteContent = hasEvidence || !!citation.quote;

  return (
    <div
      className={`relative bg-gray-200 dark:bg-surface-dark-base rounded-lg transition-all duration-300 overflow-hidden text-xs border-2 border-transparent hover:border-blue-500 hover:shadow-lg ${
        hasQuoteContent ? 'h-[188px] w-64' : 'h-[132px] w-48'
      } p-2`}
    >
      <Link
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        title={citation.title}
        className="flex flex-col h-full no-underline justify-between"
      >
        <div className="flex-grow min-h-0 flex flex-col">
          <div
            className={`text-[12.5px] ${hasQuoteContent ? 'line-clamp-2' : 'line-clamp-3'} text-gray-800 dark:text-white mb-2 shrink-0`}
          >
            {citation.title}
          </div>
          {hasEvidence ? (
            // One row per CITED number: its quote paired with ITS pages —
            // never one quote next to another chunk's locator.
            <div className="min-h-0 overflow-y-auto space-y-1.5 mb-1">
              {citation.evidence!.map((entry) => (
                <blockquote
                  key={entry.number}
                  className="text-[11.5px] italic text-gray-600 dark:text-gray-300 border-l-2 border-gray-400 dark:border-gray-500 pl-2"
                  title={entry.quote}
                >
                  <span
                    className={
                      citation.evidence!.length > 1
                        ? 'line-clamp-2'
                        : 'line-clamp-4'
                    }
                  >
                    “{entry.quote}”
                  </span>
                  <span className="not-italic text-[10.5px] text-gray-500 dark:text-gray-400">
                    [{entry.number}]{entry.locator ? ` · ${entry.locator}` : ''}
                  </span>
                </blockquote>
              ))}
            </div>
          ) : (
            citation.quote && (
              <blockquote
                className="text-[11.5px] italic line-clamp-4 text-gray-600 dark:text-gray-300 border-l-2 border-gray-400 dark:border-gray-500 pl-2 mb-1"
                title={citation.quote}
              >
                “{citation.quote}”
              </blockquote>
            )
          )}
        </div>
        {citation.locator && !hasEvidence && (
          <div
            className="text-[11px] text-gray-600 dark:text-gray-400 truncate"
            title={citation.locator}
          >
            {citation.locator}
          </div>
        )}
        {citation.date && citation.date.trim() !== '' && (
          <div className="text-[11px] text-gray-600 dark:text-gray-400 mb-6">
            {new Date(citation.date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 dark:bg-surface-dark bg-gray-100 px-2 py-1 flex items-center dark:text-white text-gray-500 text-[11.5px] space-x-1">
          <div className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://www.google.com/s2/favicons?domain=${hostname}&size=16`}
              alt={`${hostname} favicon`}
              width={12}
              height={12}
              className="mr-1 my-0 p-0 align-middle"
            />
          </div>
          <span className="truncate">{displayName}</span>
          <span>|</span>
          <span>{citation.number}</span>
        </div>
      </Link>
    </div>
  );
};

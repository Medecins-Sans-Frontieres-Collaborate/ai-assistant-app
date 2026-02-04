import React from 'react';

import Link from 'next/link';

import { Citation } from '@/types/rag';

export const CitationItem: React.FC<{ citation: Citation }> = ({
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

  return (
    <div className="relative bg-gray-200 dark:bg-[#171717] rounded-lg transition-all duration-300 overflow-hidden text-xs border-2 border-transparent hover:border-blue-500 hover:shadow-lg h-[132px] w-48 p-2">
      <Link
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        title={citation.title}
        className="flex flex-col h-full no-underline justify-between"
      >
        <div className="flex-grow">
          <div className="text-[12.5px] line-clamp-3 text-gray-800 dark:text-white mb-2">
            {citation.title}
          </div>
        </div>
        {citation.date && citation.date.trim() !== '' && (
          <div className="text-[11px] text-gray-600 dark:text-gray-400 mb-6">
            {new Date(citation.date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 dark:bg-[#1f1f1f] bg-gray-100 px-2 py-1 flex items-center dark:text-white text-gray-500 text-[11.5px] space-x-1">
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
          <span className="truncate">{cleanDomain}</span>
          <span>|</span>
          <span>{citation.number}</span>
        </div>
      </Link>
    </div>
  );
};

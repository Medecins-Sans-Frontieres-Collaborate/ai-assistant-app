import {
  IconDatabase,
  IconExternalLink,
  IconRefresh,
} from '@tabler/icons-react';
import React, { FC, useEffect, useState } from 'react';

interface RecentDoc {
  title: string;
  date: string;
  url: string;
}

interface RecentSourceData {
  sourceName: string;
  sourceUrl: string;
  latestDoc: RecentDoc;
}

interface RecentSourcesSectionProps {
  agentId: string;
}

export const RecentSourcesSection: FC<RecentSourcesSectionProps> = ({
  agentId,
}) => {
  const [sources, setSources] = useState<RecentSourceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRecentSources = async (id: string) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/search/recent?agentId=${id}`);
      if (!response.ok) {
        throw new Error('Failed to fetch');
      }
      const data = await response.json();
      setSources(data.sources || []);
    } catch (err) {
      setError('Unable to load recent sources');
      console.error('[RecentSourcesSection] Error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecentSources(agentId);
  }, [agentId]);

  // Format date for display
  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return `${diffDays} days ago`;

      // Include year if not current year
      const currentYear = now.getFullYear();
      const dateYear = date.getFullYear();

      if (dateYear !== currentYear) {
        return date.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
      }

      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  };

  // Truncate title for display
  const truncateTitle = (title: string, maxLength: number = 50) => {
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength).trim() + '...';
  };

  if (loading) {
    return (
      <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
        <div className="flex items-center gap-2 mb-3">
          <IconDatabase
            size={16}
            className="text-gray-500 dark:text-gray-400"
          />
          <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
            Latest Source Data
          </h4>
        </div>
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="animate-pulse">
              <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-1"></div>
              <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded w-1/4"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconDatabase size={16} className="text-gray-400" />
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Unable to load latest sources
            </span>
          </div>
          <button
            onClick={() => fetchRecentSources(agentId)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
          >
            <IconRefresh size={12} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (sources.length === 0) {
    return (
      <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconDatabase size={16} className="text-gray-400" />
            <span className="text-xs text-gray-500 dark:text-gray-400">
              No recent sources available
            </span>
          </div>
          <button
            onClick={() => fetchRecentSources(agentId)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
          >
            <IconRefresh size={12} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <IconDatabase
            size={16}
            className="text-gray-500 dark:text-gray-400"
          />
          <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
            Latest Source Data
          </h4>
        </div>
        <button
          onClick={() => fetchRecentSources(agentId)}
          className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          title="Refresh"
        >
          <IconRefresh size={14} />
        </button>
      </div>

      <div className="space-y-3">
        {sources.map((source, index) => (
          <div key={index} className="group">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <a
                  href={source.latestDoc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors line-clamp-2"
                  title={source.latestDoc.title}
                >
                  {truncateTitle(source.latestDoc.title, 60)}
                  <IconExternalLink
                    size={12}
                    className="inline-block ml-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </a>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-gray-500 dark:text-gray-500">
                    {source.sourceName}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-600">
                    •
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-500">
                    {formatDate(source.latestDoc.date)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

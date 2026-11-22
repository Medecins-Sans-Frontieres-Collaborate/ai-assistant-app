'use client';

import { IconPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import {
  createBrandBook,
  deleteBrandBook,
  listAdminBrandBooks,
} from '@/client/services/brand/brandBookAdmin';

import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';

import { RuleEditor } from '../RuleEditor';
import {
  AdminBrandBooksResponse,
  AdminRulesResponse,
  AdminStoredBrandBook,
  CLIENT_BRAND_BOOK_SOURCE,
  MergedAgentRow,
} from '../types';

/** Most palette swatches a row shows. */
const ROW_SWATCHES = 8;

/**
 * Admin list of brand books with per-book access rules
 * (docs/DOCUMENT_PLATFORM.md, phase E). Rows reuse MergedAgentRow so the
 * shared RuleEditor works unchanged over the `brand-book::<id>` key.
 * Creating a book makes an empty one and opens its full-page editor, where
 * a draft can be made from a brand guide.
 */
export function BrandBooksSection() {
  const t = useTranslations('agentAccess');
  const tb = useTranslations('adminBrandBooks');
  const router = useRouter();
  const queryClient = useQueryClient();

  const booksQuery = useQuery<AdminBrandBooksResponse>({
    queryKey: ['agent-access-brand-books'],
    queryFn: listAdminBrandBooks,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const rulesQuery = useQuery<AdminRulesResponse>({
    queryKey: ['agent-access-rules'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/rules');
      if (!response.ok) {
        throw new Error(`Failed to fetch rules: ${response.status}`);
      }
      return unwrapApiData<AdminRulesResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const [editingRuleKey, setEditingRuleKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const rulesByKey = new Map(
      (rulesQuery.data?.rules ?? []).map((r) => [r.canonicalKey, r]),
    );
    return (booksQuery.data?.books ?? [])
      .map((entry: AdminStoredBrandBook) => ({
        row: {
          canonicalKey: entry.canonicalKey,
          source: CLIENT_BRAND_BOOK_SOURCE,
          agentName: entry.record.id,
          displayName: entry.record.book.name,
          discoverable: true,
          stored: rulesByKey.get(entry.canonicalKey) ?? null,
          promptAgent: null,
        } satisfies MergedAgentRow,
        entry,
      }))
      .sort((a, b) => a.row.displayName.localeCompare(b.row.displayName));
  }, [booksQuery.data, rulesQuery.data]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['agent-access-brand-books'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-rules'] }),
      queryClient.invalidateQueries({ queryKey: ['brand-books'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-config'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-access-me'] }),
    ]);
  };

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const empty = parseBrandBookBody({ name: tb('untitled') });
      if (!empty.ok) throw new Error(empty.error);
      const created = await createBrandBook(empty.body);
      await invalidate();
      router.push(`/admin/brand-books/${created.record.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (entry: AdminStoredBrandBook) => {
    setBusy(true);
    setError(null);
    try {
      await deleteBrandBook(entry.record.id, entry.etag);
      setConfirmDeleteId(null);
      await invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setBusy(false);
    }
  };

  const buttonClass =
    'shrink-0 rounded-md border border-gray-200 px-3 py-1 text-sm text-black hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800';

  if (booksQuery.isLoading) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('loading')}</p>
    );
  }
  if (booksQuery.error || booksQuery.data?.booksUnavailable) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        <p>
          {booksQuery.data?.booksUnavailable
            ? tb('unavailable')
            : t('loadError')}
        </p>
        <button
          type="button"
          className={`mt-2 ${buttonClass}`}
          onClick={() => void booksQuery.refetch()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
        {tb('intro')}
      </p>
      <button
        type="button"
        disabled={busy}
        className="mb-4 flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-black hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800"
        onClick={() => void handleCreate()}
      >
        <IconPlus size={16} />
        {tb('add')}
      </button>
      {error && (
        <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{tb('none')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ row, entry }) => {
            const isRestricted = row.stored?.rule.access.type === 'restricted';
            const { book } = entry.record;
            return (
              <li
                key={row.canonicalKey}
                className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-sm font-medium text-black dark:text-white">
                      {row.displayName}
                    </span>
                    {book.description && (
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {book.description}
                      </p>
                    )}
                  </div>
                  {book.palette.length > 0 && (
                    <span
                      className="flex shrink-0 overflow-hidden rounded border border-gray-200 dark:border-gray-700"
                      aria-label={tb('paletteSummary', {
                        count: book.palette.length,
                      })}
                      role="img"
                    >
                      {book.palette.slice(0, ROW_SWATCHES).map((color) => (
                        <span
                          key={color.name}
                          className="h-5 w-4"
                          style={{ backgroundColor: color.hex }}
                          title={`${color.name} ${color.hex}`}
                        />
                      ))}
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                    {tb('summary', {
                      fonts: book.fonts.length,
                      logos: book.logos.length,
                    })}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      isRestricted
                        ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                        : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                    }`}
                  >
                    {isRestricted ? t('accessRestricted') : t('accessEveryone')}
                  </span>
                  <button
                    type="button"
                    className={buttonClass}
                    aria-expanded={editingRuleKey === row.canonicalKey}
                    onClick={() =>
                      setEditingRuleKey(
                        editingRuleKey === row.canonicalKey
                          ? null
                          : row.canonicalKey,
                      )
                    }
                  >
                    {editingRuleKey === row.canonicalKey
                      ? t('cancel')
                      : t('editAccess')}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      router.push(`/admin/brand-books/${entry.record.id}`)
                    }
                  >
                    {tb('open')}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-red-200 px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
                    aria-expanded={confirmDeleteId === entry.record.id}
                    onClick={() =>
                      setConfirmDeleteId(
                        confirmDeleteId === entry.record.id
                          ? null
                          : entry.record.id,
                      )
                    }
                  >
                    {tb('delete')}
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  {t('updatedByLine', {
                    user: entry.record.updatedBy,
                    date: entry.record.updatedAt,
                  })}
                </p>
                {editingRuleKey === row.canonicalKey && (
                  <RuleEditor
                    key={`${row.canonicalKey}:${row.stored?.etag ?? 'none'}`}
                    row={row}
                    onSaved={async () => {
                      setEditingRuleKey(null);
                      await invalidate();
                    }}
                    onCancel={() => setEditingRuleKey(null)}
                    onConflictReload={async () => {
                      setEditingRuleKey(null);
                      await rulesQuery.refetch();
                    }}
                  />
                )}
                {confirmDeleteId === entry.record.id && (
                  <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
                    <p>{tb('deleteConfirm', { name: book.name })}</p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        onClick={() => void handleDelete(entry)}
                        disabled={busy}
                      >
                        {tb('deleteConfirmButton')}
                      </button>
                      <button
                        type="button"
                        className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={busy}
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

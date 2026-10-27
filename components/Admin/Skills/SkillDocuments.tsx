'use client';

import { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';
import type { AdminSkillEntry } from '@/client/hooks/settings/useSkillsAdmin';

import {
  SKILL_DOCUMENT_EXTENSIONS,
  validateSkillFiles,
} from '@/lib/services/skills/skillFiles';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_SECONDARY,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';

/** Admin resource list with resumable indexing, progress, downloads, and removal. */
export function SkillDocuments({
  entry,
  refresh,
}: {
  entry: AdminSkillEntry;
  refresh: () => Promise<unknown>;
}) {
  const t = useTranslations('skillsAdmin.documents');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      running.current = false;
      abort.current?.abort();
    };
  }, []);
  const base = `/api/agent-access/skills/${entry.skill.id}`;

  const check = async (response: Response) => {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? t('requestFailed'));
    }
    return response;
  };
  const run = async () => {
    setBusy(true);
    setError('');
    running.current = true;
    try {
      // One bounded step per request. The durable manifest is the checkpoint,
      // so closing this page or stopping here never loses completed batches.
      for (
        let step = 0;
        step < 50 && running.current && mounted.current;
        step++
      ) {
        abort.current = new AbortController();
        const response = await check(
          await fetch(`${base}/index${step === 0 ? '?retry=true' : ''}`, {
            method: 'POST',
            signal: abort.current.signal,
          }),
        );
        const state = unwrapApiData<{ pending: boolean; busy: boolean }>(
          await response.json(),
        );
        await refresh();
        if (!state.pending) break;
      }
    } catch (error) {
      if (mounted.current && running.current)
        setError(error instanceof Error ? error.message : t('requestFailed'));
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        await refresh();
      }
    }
  };
  const upload = async (files: File[]) => {
    if (!files.length || !entry.etag) return;
    setBusy(true);
    setError('');
    try {
      validateSkillFiles(files);
      const form = new FormData();
      for (const file of files) form.append('files', file);
      await check(
        await fetch(`${base}/documents`, {
          method: 'POST',
          headers: { 'if-match': entry.etag },
          body: form,
        }),
      );
      await refresh();
      await run();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('requestFailed'));
    } finally {
      if (mounted.current) setBusy(false);
      await refresh();
    }
  };
  const remove = async (fileId: string) => {
    if (!entry.etag) return;
    const document = entry.skill.documents.find((doc) => doc.fileId === fileId);
    if (
      !document ||
      !window.confirm(t('confirmRemove', { filename: document.filename }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await check(
        await fetch(`${base}/documents?fileId=${encodeURIComponent(fileId)}`, {
          method: 'DELETE',
          headers: { 'if-match': entry.etag },
        }),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : t('requestFailed'));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const unfinished =
    entry.requiresReindex ||
    entry.skill.documents.some(
      (doc) =>
        ['pending', 'processing', 'failed'].includes(doc.indexStatus) ||
        (doc.indexStatus === 'indexed' && !doc.embeddingRegion),
    );
  return (
    <section
      aria-label={t('title')}
      className="mt-3 space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700"
    >
      <h3 className={ADMIN_LABEL}>{t('title')}</h3>
      <p className={ADMIN_HINT}>{t('hint')}</p>
      {entry.requiresReindex && (
        <p className={ADMIN_BANNER_WARN}>{t('reindexRequired')}</p>
      )}
      {!entry.etag ? (
        <p className={ADMIN_MUTED}>{t('saveFirst')}</p>
      ) : (
        <label className={ADMIN_LABEL}>
          {t('upload')}
          <input
            type="file"
            multiple
            accept={SKILL_DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`).join(',')}
            className={`${ADMIN_FIELD} mt-1 block w-full`}
            disabled={busy}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void upload(files);
            }}
          />
        </label>
      )}
      {error && (
        <p role="alert" className={ADMIN_BANNER_ERROR}>
          {error}
        </p>
      )}
      <ul className="divide-y divide-gray-200 dark:divide-gray-700">
        {entry.skill.documents.map((doc) => (
          <li
            key={doc.fileId}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <div className="min-w-0 flex-1">
              <a
                className="break-all text-sm underline"
                href={`${base}/documents?fileId=${doc.fileId}`}
              >
                {doc.resourcePath ?? doc.filename}
              </a>
              <p className={ADMIN_HINT}>
                {t(`status.${doc.indexStatus}`)}
                {doc.chunkCount &&
                doc.indexStatus !== 'inline' &&
                doc.indexStatus !== 'asset'
                  ? ` (${doc.nextChunk}/${doc.chunkCount})`
                  : ''}
              </p>
              {doc.error && (
                <p className="text-xs text-red-700 dark:text-red-300">
                  {doc.error}
                </p>
              )}
            </div>
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              disabled={busy}
              onClick={() => void remove(doc.fileId)}
              aria-label={`${t('remove')}: ${doc.filename}`}
            >
              {t('remove')}
            </button>
          </li>
        ))}
      </ul>
      {busy ? (
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={() => {
            running.current = false;
            abort.current?.abort();
          }}
        >
          {t('stop')}
        </button>
      ) : (
        unfinished && (
          <button
            type="button"
            className={ADMIN_BTN_PRIMARY}
            onClick={() => void run()}
          >
            {t('resume')}
          </button>
        )
      )}
      {!entry.skill.documents.length && (
        <p className={ADMIN_MUTED}>{t('empty')}</p>
      )}
    </section>
  );
}

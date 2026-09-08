'use client';

import {
  IconBrandGithub,
  IconExternalLink,
  IconSparkles,
} from '@tabler/icons-react';
import { FC, useEffect, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import { fetchReleaseNotes } from '@/client/services/releases/releasesClient';

import { githubReleasesUrl } from '@/lib/utils/shared/githubReleases';

import type { ReleaseNotesPayload } from '@/types/releases';

import Modal from '@/components/UI/Modal';

// Loaded on open only: pulling Streamdown (and Shiki, and KaTeX) into the app
// shell for a panel most people never open would be a poor trade. MathStreamdown
// rather than Streamdown so the sanitize schema travels in the same chunk.
const Markdown = dynamic(() => import('@/components/Markdown/MathStreamdown'), {
  ssr: false,
});

/**
 * Release note links point at github.com, so they must leave the SPA in a new
 * tab rather than navigating the chat away mid-conversation.
 */
const MARKDOWN_COMPONENTS = {
  a: ({
    node: _node,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 dark:text-blue-400 hover:underline"
    />
  ),
};

function formatDate(iso: string, locale: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
      new Date(ms),
    );
  } catch {
    // An unsupported locale tag must not cost the reader the whole panel.
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * Body of the panel, mounted only while it is open.
 *
 * Split out so "opening" is a mount rather than a state transition: the fetch
 * belongs to a mount effect, `loading` is simply the initial state, and
 * closing unmounts — which aborts the request and resets everything for the
 * next open without a single reset branch.
 */
const ReleaseNotesBody: FC = () => {
  const t = useTranslations();
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<ReleaseNotesPayload | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    fetchReleaseNotes({ signal: controller.signal })
      .then((result) => {
        if (!cancelled) setPayload(result);
      })
      .catch(() => {
        // Only aborts reach here; the client never rejects otherwise.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const releasesUrl = payload?.releasesUrl || githubReleasesUrl();
  const releases = payload?.releases ?? [];

  return (
    <>
      <div className="max-h-[60vh] overflow-y-auto">
        {loading && (
          <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('releaseNotes.loading')}
          </p>
        )}

        {!loading && releases.length === 0 && (
          <p className="py-6 text-center text-sm text-gray-600 dark:text-gray-300">
            {t('releaseNotes.unavailable')}
          </p>
        )}

        {!loading && releases.length > 0 && (
          <div className="space-y-5">
            {payload?.stale && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('releaseNotes.stale')}
              </p>
            )}

            {releases.map((release) => (
              <article
                key={release.tag}
                className="border-b border-gray-200 dark:border-gray-700 pb-5 last:border-b-0 last:pb-0"
              >
                <header className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <a
                    href={release.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-base font-semibold text-gray-900 dark:text-white hover:underline"
                  >
                    {release.name}
                  </a>
                  {release.publishedAt && (
                    <time
                      dateTime={release.publishedAt}
                      className="text-xs text-gray-500 dark:text-gray-400"
                    >
                      {formatDate(release.publishedAt, locale)}
                    </time>
                  )}
                </header>

                {release.body ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none text-sm text-gray-700 dark:text-gray-300">
                    <Markdown mode="static" components={MARKDOWN_COMPONENTS}>
                      {release.body}
                    </Markdown>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('releaseNotes.noDetails')}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Rendered inside the panel rather than via Modal's `footer` slot so it
          sits outside the scroll container above — the GitHub link is the
          fallback for every failure and must never be scrolled out of reach. */}
      <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('releaseNotes.englishOnly')}
        </p>
        <a
          href={releasesUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
        >
          <IconBrandGithub size={16} />
          {t('releaseNotes.viewOnGithub')}
          <IconExternalLink size={14} />
        </a>
      </div>
    </>
  );
};

interface ReleaseNotesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * "What's new" — the recent public GitHub releases, rendered in-app.
 *
 * Read-only and entirely optional: every failure path lands on the same
 * "view on GitHub" link, because this panel hangs off the update banner and
 * must never be able to make updating harder than it already was.
 */
export const ReleaseNotesModal: FC<ReleaseNotesModalProps> = ({
  isOpen,
  onClose,
}) => {
  const t = useTranslations();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      // Above the update banner (z-[59]) and the welcome banner (z-[60]) it can
      // be opened from, and above the settings dialog (z-50).
      className="z-[70]"
      icon={
        <IconSparkles
          size={20}
          className="text-amber-600 dark:text-amber-400"
        />
      }
      title={t('releaseNotes.title')}
    >
      {isOpen && <ReleaseNotesBody />}
    </Modal>
  );
};

export default ReleaseNotesModal;

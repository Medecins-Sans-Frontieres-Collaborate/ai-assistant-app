import {
  IconCalendarEvent,
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconLoader2,
  IconVideo,
} from '@tabler/icons-react';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useLocale, useTranslations } from 'next-intl';

import { useM365Attachment } from '@/client/hooks/chat/useM365Attachment';

import {
  M365ClientError,
  fetchMeetingTranscript,
  importMeetingRecording,
  listMeetings,
  listMeetingsWithArtifacts,
  resolveMeeting,
} from '@/client/services/m365/m365Client';

import type {
  M365MeetingArtifact,
  M365MeetingCandidate,
  M365MeetingEntry,
  M365MeetingResources,
  M365MeetingTranscript,
} from '@/types/m365';

import Modal from '@/components/UI/Modal';

interface M365MeetingImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tier 1: the parsed transcript, ready to insert into the conversation. */
  onImportTranscript: (
    transcript: M365MeetingTranscript,
    meeting: M365MeetingEntry,
  ) => void;
}

function errorMessageKey(error: unknown): string {
  if (error instanceof M365ClientError) {
    if (error.code === 'M365_CONSENT_MISSING') return 'errors.consentMissing';
    if (error.code === 'M365_NOT_CONNECTED') return 'errors.notConnected';
    if (error.code === 'NETWORK') return 'errors.network';
  }
  return 'errors.generic';
}

/** A cancelled fetch is the caller's own doing — never user-facing copy. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * The meeting scopes can be unconsented while the calendar ones are not, in
 * which case only the filtered listing fails. Falling back to the plain
 * listing beats a dead error screen.
 */
function filterUnavailable(error: unknown): boolean {
  return (
    error instanceof M365ClientError &&
    (error.code === 'M365_CONSENT_MISSING' || error.code === 'M365_FORBIDDEN')
  );
}

type ResourceState = M365MeetingResources | 'loading' | 'forbidden' | 'error';

/**
 * "From a meeting": recent Teams meetings from the user's calendar, each
 * expandable to its transcript/recording availability. Transcript imports
 * are near-instant (tier 1); recording imports land the MP4 in upload
 * storage server-side and hand it to the standard transcription pipeline
 * (tier 2). Delegated throughout — only meetings the user organized or
 * attended resolve.
 *
 * Two listing modes. The default asks the server to probe availability and
 * returns only meetings with something attachable, resources already
 * resolved — so expanding a row costs nothing and every row is actionable.
 * "Show all meetings" falls back to the plain calendar listing with the
 * original lazy per-meeting resolve, which is the escape hatch whenever the
 * probe could not reach a verdict (denied, throttled, out of budget).
 */
const M365MeetingImportBody: FC<{
  onClose: () => void;
  onImportTranscript: M365MeetingImportModalProps['onImportTranscript'];
}> = ({ onClose, onImportTranscript }) => {
  const t = useTranslations('m365.meetings');
  const locale = useLocale();
  const { attachImportedUpload } = useM365Attachment();

  const [mode, setMode] = useState<'filtered' | 'all'>('filtered');
  const [meetings, setMeetings] = useState<M365MeetingCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resources, setResources] = useState<Record<string, ResourceState>>({});
  const [importing, setImporting] = useState<string | null>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [unprobedCount, setUnprobedCount] = useState(0);
  const [throttled, setThrottled] = useState(false);
  const [windowTruncated, setWindowTruncated] = useState(false);
  const [filterFailed, setFilterFailed] = useState(false);
  const mounted = useRef(true);
  /**
   * Bumped on every mode switch. A lazy resolve started in one mode must
   * not write its answer into the other mode's cache — the two disagree
   * (the filtered listing seeds server-probed verdicts) and the resolve
   * has no AbortController of its own.
   */
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setErrorKey(null);

    const load = async () => {
      if (mode === 'all') {
        const found = await listMeetings({ signal: controller.signal });
        if (cancelled) return;
        setMeetings(
          found.map((meeting) => ({
            ...meeting,
            availability: 'unprobed' as const,
          })),
        );
        setHiddenCount(0);
        setUnprobedCount(0);
        setThrottled(false);
        setWindowTruncated(false);
        return;
      }

      const page = await listMeetingsWithArtifacts({
        signal: controller.signal,
      });
      if (cancelled) return;
      // Consent can be granted, or a transient 403 clear, between attempts:
      // a successful filtered load must retire the fallback notice.
      setFilterFailed(false);
      setMeetings(page.meetings ?? []);
      setHiddenCount(page.hiddenCount ?? 0);
      setUnprobedCount(page.unprobedCount ?? 0);
      setThrottled(!!page.throttled);
      setWindowTruncated(!!page.windowTruncated);
      // The server already resolved what it could: seed the expand cache so
      // opening a row is instant and issues no second round trip.
      setResources((prev) => {
        const seeded = { ...prev };
        for (const meeting of page.meetings ?? []) {
          if (meeting.resources) {
            seeded[meeting.eventId] = meeting.resources;
          } else if (meeting.availability === 'forbidden') {
            seeded[meeting.eventId] = 'forbidden';
          }
        }
        return seeded;
      });
    };

    load()
      .catch((error) => {
        if (cancelled || isAbort(error)) return;
        if (mode === 'filtered' && filterUnavailable(error)) {
          setFilterFailed(true);
          setMode('all');
          return;
        }
        setErrorKey(errorMessageKey(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mode]);

  const toggleExpand = useCallback(
    (meeting: M365MeetingEntry) => {
      const next = expandedId === meeting.eventId ? null : meeting.eventId;
      setExpandedId(next);
      if (next && !resources[meeting.eventId]) {
        const startedIn = generation.current;
        const stale = () =>
          !mounted.current || generation.current !== startedIn;
        setResources((prev) => ({ ...prev, [meeting.eventId]: 'loading' }));
        resolveMeeting(meeting.joinWebUrl)
          .then((resolved) => {
            if (stale()) return;
            setResources((prev) => ({ ...prev, [meeting.eventId]: resolved }));
          })
          .catch((error) => {
            if (stale()) return;
            const forbidden =
              error instanceof M365ClientError &&
              error.code === 'M365_FORBIDDEN';
            setResources((prev) => ({
              ...prev,
              [meeting.eventId]: forbidden ? 'forbidden' : 'error',
            }));
          });
      }
    },
    [expandedId, resources],
  );

  const importTranscript = useCallback(
    async (
      meeting: M365MeetingEntry,
      meetingId: string,
      transcriptId: string,
    ) => {
      const key = `t:${transcriptId}`;
      setImporting(key);
      try {
        const transcript = await fetchMeetingTranscript(
          meetingId,
          transcriptId,
          {
            subject: meeting.subject,
            start: meeting.start,
          },
        );
        onImportTranscript(transcript, meeting);
        onClose();
      } catch (error) {
        toast.error(t(errorMessageKey(error)));
      } finally {
        setImporting(null);
      }
    },
    [onImportTranscript, onClose, t],
  );

  const importRecording = useCallback(
    async (
      meeting: M365MeetingEntry,
      meetingId: string,
      recordingId: string,
    ) => {
      const key = `r:${recordingId}`;
      setImporting(key);
      try {
        const imported = await importMeetingRecording(
          meetingId,
          recordingId,
          `${meeting.subject}${meeting.start ? ` (${meeting.start.slice(0, 10)})` : ''}`,
        );
        attachImportedUpload(imported);
        toast.success(t('recordingAttached'));
        onClose();
      } catch (error) {
        const tooLarge =
          error instanceof M365ClientError &&
          error.code === 'M365_FILE_TOO_LARGE';
        toast.error(
          tooLarge ? t('recordingTooLarge') : t(errorMessageKey(error)),
        );
      } finally {
        setImporting(null);
      }
    },
    [attachImportedUpload, onClose, t],
  );

  const formatWhen = useCallback(
    (iso?: string): string => {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleDateString(locale, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return '';
      }
    },
    [locale],
  );

  /** Labels an artifact by its own date — a deduped series carries many. */
  const artifactLabel = useCallback(
    (artifact: M365MeetingArtifact, kind: 'transcript' | 'recording') => {
      const when = formatWhen(artifact.created);
      if (!when) {
        return kind === 'transcript'
          ? t('importTranscript')
          : t('importRecording');
      }
      return kind === 'transcript'
        ? t('importTranscriptFrom', { when })
        : t('importRecordingFrom', { when });
    },
    [formatWhen, t],
  );

  const filtered = mode === 'filtered';
  const toggleMode = useCallback(() => {
    generation.current += 1;
    setExpandedId(null);
    // The two modes disagree about what a row's resources are: filtered
    // seeds the server's probe verdict (including 'forbidden', which is a
    // sentinel the lazy path would otherwise never be asked to revisit).
    // Carrying that over would make "Show all" no escape hatch at all.
    setResources({});
    setMode((current) => (current === 'filtered' ? 'all' : 'filtered'));
  }, []);

  const renderBadges = (meeting: M365MeetingCandidate) => {
    if (!filtered) return null;
    const badge = (label: string, tone: 'ok' | 'warn' | 'muted') => (
      <span
        key={label}
        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
          tone === 'ok'
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
            : tone === 'warn'
              ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
              : 'bg-gray-100 text-gray-600 dark:bg-neutral-700 dark:text-gray-300'
        }`}
      >
        {label}
      </span>
    );
    if (meeting.availability === 'forbidden') {
      return badge(t('badgeNoAccess'), 'warn');
    }
    if (meeting.availability === 'pending') {
      return badge(t('badgePending'), 'muted');
    }
    const transcripts = meeting.resources?.transcripts.length ?? 0;
    const recordings = meeting.resources?.recordings.length ?? 0;
    return (
      <>
        {transcripts > 0 &&
          badge(
            transcripts > 1
              ? t('badgeTranscripts', { count: transcripts })
              : t('badgeTranscript'),
            'ok',
          )}
        {recordings > 0 &&
          badge(
            recordings > 1
              ? t('badgeRecordings', { count: recordings })
              : t('badgeRecording'),
            'ok',
          )}
      </>
    );
  };

  return (
    <div className="flex h-[420px] flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            {filtered ? t('loadingFiltered') : t('loading')}
          </div>
        ) : errorKey ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-amber-700 dark:text-amber-400">
            {t(errorKey)}
          </div>
        ) : meetings.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {filtered ? t('emptyFiltered') : t('empty')}
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-700/50">
            {meetings.map((meeting) => {
              const expanded = expandedId === meeting.eventId;
              const resource = resources[meeting.eventId];
              return (
                <li key={meeting.eventId}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleExpand(meeting)}
                      aria-expanded={expanded}
                      aria-controls={`m365-meeting-${meeting.eventId}`}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      {expanded ? (
                        <IconChevronDown
                          size={16}
                          className="flex-shrink-0 text-gray-400"
                        />
                      ) : (
                        <IconChevronRight
                          size={16}
                          className="flex-shrink-0 text-gray-400"
                        />
                      )}
                      <IconCalendarEvent
                        size={18}
                        className="flex-shrink-0 text-indigo-500"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                          {meeting.subject}
                        </span>
                        <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                          {[
                            meeting.organizer,
                            formatWhen(meeting.start),
                            meeting.occurrences && meeting.occurrences > 1
                              ? t('occurrences', { count: meeting.occurrences })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="flex flex-shrink-0 items-center gap-1">
                        {renderBadges(meeting)}
                      </span>
                    </button>
                  </div>
                  {expanded && (
                    <div
                      id={`m365-meeting-${meeting.eventId}`}
                      className="pb-2 pl-12 pr-3 text-sm"
                    >
                      {resource === 'loading' || resource === undefined ? (
                        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                          <IconLoader2 size={14} className="animate-spin" />
                          {t('checkingAvailability')}
                        </div>
                      ) : resource === 'forbidden' ? (
                        <p className="text-xs text-amber-700 dark:text-amber-400">
                          {t('transcriptDenied', {
                            organizer: meeting.organizer ?? t('theOrganizer'),
                          })}
                        </p>
                      ) : resource === 'error' ? (
                        <p className="text-xs text-amber-700 dark:text-amber-400">
                          {t('resolveFailed')}
                        </p>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {resource.transcripts.length === 0 &&
                            resource.recordings.length === 0 && (
                              <p className="text-xs text-gray-500 dark:text-gray-400">
                                {meeting.availability === 'pending'
                                  ? t('pendingHint')
                                  : t('nothingAvailable')}
                              </p>
                            )}
                          {resource.transcripts.map((artifact) => (
                            <button
                              key={artifact.id}
                              type="button"
                              disabled={importing !== null}
                              onClick={() =>
                                void importTranscript(
                                  meeting,
                                  resource.meetingId,
                                  artifact.id,
                                )
                              }
                              className="flex w-fit items-center gap-1.5 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                            >
                              {importing === `t:${artifact.id}` ? (
                                <IconLoader2
                                  size={14}
                                  className="animate-spin"
                                />
                              ) : (
                                <IconFileText size={14} />
                              )}
                              {artifactLabel(artifact, 'transcript')}
                            </button>
                          ))}
                          {resource.recordings.map((artifact) => (
                            <button
                              key={artifact.id}
                              type="button"
                              disabled={importing !== null}
                              onClick={() =>
                                void importRecording(
                                  meeting,
                                  resource.meetingId,
                                  artifact.id,
                                )
                              }
                              className="flex w-fit items-center gap-1.5 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                              title={t('importRecordingHint')}
                            >
                              {importing === `r:${artifact.id}` ? (
                                <IconLoader2
                                  size={14}
                                  className="animate-spin"
                                />
                              ) : (
                                <IconVideo size={14} />
                              )}
                              {artifactLabel(artifact, 'recording')}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {!loading && (
          <button
            type="button"
            onClick={toggleMode}
            className="w-fit text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {filtered
              ? hiddenCount > 0
                ? t('showAllWithCount', { count: hiddenCount })
                : t('showAll')
              : t('showFiltered')}
          </button>
        )}
        {filterFailed && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t('filterUnavailable')}
          </p>
        )}
        {filtered && unprobedCount > 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-500">
            {t('someUnchecked', { count: unprobedCount })}
          </p>
        )}
        {filtered && throttled && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t('throttledNote')}
          </p>
        )}
        {filtered && windowTruncated && (
          <p className="text-xs text-gray-500 dark:text-gray-500">
            {t('windowTruncated')}
          </p>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-500">
          {filtered ? t('filteringNote') : t('delegatedNote')}
        </p>
      </div>
    </div>
  );
};

const M365MeetingImportModal: FC<M365MeetingImportModalProps> = ({
  isOpen,
  onClose,
  onImportTranscript,
}) => {
  const t = useTranslations('m365.meetings');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('title')}
      icon={<IconCalendarEvent size={20} />}
      size="lg"
    >
      {isOpen && (
        <M365MeetingImportBody
          onClose={onClose}
          onImportTranscript={onImportTranscript}
        />
      )}
    </Modal>
  );
};

export default M365MeetingImportModal;

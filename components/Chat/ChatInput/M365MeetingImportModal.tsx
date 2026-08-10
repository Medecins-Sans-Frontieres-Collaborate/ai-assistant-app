import {
  IconCalendarEvent,
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconLoader2,
  IconVideo,
} from '@tabler/icons-react';
import { FC, useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { useLocale, useTranslations } from 'next-intl';

import { useM365Attachment } from '@/client/hooks/chat/useM365Attachment';

import {
  M365ClientError,
  fetchMeetingTranscript,
  importMeetingRecording,
  listMeetings,
  resolveMeeting,
} from '@/client/services/m365/m365Client';

import type {
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

/**
 * "From a meeting": recent Teams meetings from the user's calendar, each
 * expandable to its transcript/recording availability. Transcript imports
 * are near-instant (tier 1); recording imports land the MP4 in upload
 * storage server-side and hand it to the standard transcription pipeline
 * (tier 2). Delegated throughout — only meetings the user organized or
 * attended resolve.
 */
const M365MeetingImportBody: FC<{
  onClose: () => void;
  onImportTranscript: M365MeetingImportModalProps['onImportTranscript'];
}> = ({ onClose, onImportTranscript }) => {
  const t = useTranslations('m365.meetings');
  const locale = useLocale();
  const { attachImportedUpload } = useM365Attachment();

  const [meetings, setMeetings] = useState<M365MeetingEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resources, setResources] = useState<
    Record<string, M365MeetingResources | 'loading' | 'forbidden' | 'error'>
  >({});
  const [importing, setImporting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorKey(null);
    listMeetings()
      .then((found) => {
        if (!cancelled) setMeetings(found);
      })
      .catch((error) => {
        if (!cancelled) setErrorKey(errorMessageKey(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleExpand = useCallback(
    (meeting: M365MeetingEntry) => {
      const next = expandedId === meeting.eventId ? null : meeting.eventId;
      setExpandedId(next);
      if (next && !resources[meeting.eventId]) {
        setResources((prev) => ({ ...prev, [meeting.eventId]: 'loading' }));
        resolveMeeting(meeting.joinWebUrl)
          .then((resolved) => {
            setResources((prev) => ({ ...prev, [meeting.eventId]: resolved }));
          })
          .catch((error) => {
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

  return (
    <div className="flex h-[420px] flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            {t('loading')}
          </div>
        ) : errorKey ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-amber-700 dark:text-amber-400">
            {t(errorKey)}
          </div>
        ) : meetings.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('empty')}
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
                          {[meeting.organizer, formatWhen(meeting.start)]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </button>
                  </div>
                  {expanded && (
                    <div className="pb-2 pl-12 pr-3 text-sm">
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
                                {t('nothingAvailable')}
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
                              {t('importTranscript')}
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
                              {t('importRecording')}
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
      <p className="text-xs text-gray-500 dark:text-gray-500">
        {t('delegatedNote')}
      </p>
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

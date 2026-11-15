import {
  IconBrandOnedrive,
  IconCalendarEvent,
  IconCamera,
  IconDeviceLaptop,
  IconLink,
  IconMail,
  IconUpload,
} from '@tabler/icons-react';
import {
  ClipboardEvent,
  DragEvent,
  FC,
  ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useM365Attachment } from '@/client/hooks/chat/useM365Attachment';

import {
  ADD_INTENT_ORDER,
  AddIntent,
  AddSourceId,
  AddToChatCapabilities,
  M365_ADD_SOURCES,
  acceptedExtensions,
  effectiveIntent,
  filesForIntent,
  initialSource,
  intentsForSelection,
  sourceServesIntent,
  visibleSources,
} from '@/lib/utils/app/addToChat';

import type {
  M365DriveEntry,
  M365MeetingEntry,
  M365MeetingTranscript,
} from '@/types/m365';

import { M365FilePickerBody } from '@/components/Chat/ChatInput/M365FilePickerModal';
import { M365MailImportBody } from '@/components/Chat/ChatInput/M365MailImportModal';
import { M365MeetingImportBody } from '@/components/Chat/ChatInput/M365MeetingImportModal';
import { UrlAttachForm } from '@/components/Chat/ChatInput/UrlAttachModal';
import Modal from '@/components/UI/Modal';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface AddToChatDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** What the menu row that opened the picker was for. */
  initialIntent: AddIntent;
  /** What this person can add from. */
  capabilities: AddToChatCapabilities;
  /**
   * Opens the system file dialog for the intent. Called straight from a
   * click, which browsers require. The picker stays open underneath, so
   * cancelling the system dialog returns here; the caller closes the picker
   * once files arrive.
   */
  onBrowseDevice: (intent: AddIntent) => void;
  /** Files dropped or pasted into the picker, already narrowed to the intent. */
  onDeviceFiles: (files: File[], intent: AddIntent) => void;
  /** Starts the camera capture flow. */
  onOpenCamera: () => void;
  /** Hands a OneDrive / SharePoint document to the translation form. */
  onTranslateDriveItem: (entry: M365DriveEntry) => void;
  /** Inserts an imported meeting transcript into the conversation. */
  onImportTranscript: (
    transcript: M365MeetingTranscript,
    meeting: M365MeetingEntry,
  ) => void;
}

const SOURCE_ICONS: Record<AddSourceId, typeof IconLink> = {
  device: IconDeviceLaptop,
  link: IconLink,
  camera: IconCamera,
  onedrive: IconBrandOnedrive,
  mail: IconMail,
  meetings: IconCalendarEvent,
};

const TITLE_KEYS: Record<AddIntent, string> = {
  attach: 'title',
  translate: 'titleTranslate',
  transcribe: 'titleTranscribe',
};

const PRIMARY_BUTTON_CLASSES =
  'min-h-[36px] rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40';

const QUIET_BUTTON_CLASSES =
  'min-h-[36px] rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-neutral-700';

/** Whether a drag carries files (as opposed to text or a dragged element). */
function dragCarriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * One opening of the picker. Mounted fresh each time, so the intent, the
 * landing source and the selection never leak from a previous opening.
 */
const AddToChatSession: FC<Omit<AddToChatDialogProps, 'isOpen'>> = ({
  onClose,
  initialIntent,
  capabilities,
  onBrowseDevice,
  onDeviceFiles,
  onOpenCamera,
  onTranslateDriveItem,
  onImportTranscript,
}) => {
  const t = useTranslations('addToChat');
  const tPicker = useTranslations('m365.picker');
  const tRoot = useTranslations();
  const { attachDriveItem } = useM365Attachment();
  const setLastSource = useSettingsStore(
    (state) => state.setAddToChatLastSource,
  );

  const [intent, setIntent] = useState<AddIntent>(initialIntent);
  const [source, setSource] = useState<AddSourceId>(() =>
    initialSource(
      useSettingsStore.getState().addToChatLastSource,
      initialIntent,
      capabilities,
    ),
  );
  // OneDrive / SharePoint files ticked so far, keyed by `driveId/itemId`.
  // Owned here rather than by the file browser because this dialog decides
  // what happens to them.
  const [selected, setSelected] = useState<Map<string, M365DriveEntry>>(
    () => new Map(),
  );
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  // On phones the sources are a scrolling strip: keep the chosen one in
  // view, including when the picker opens on a source far along it. A ref
  // callback rather than an effect, because the dialog's content is not in
  // the document yet when this component's first effects run.
  const keepInView = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, []);

  const sources = useMemo(() => visibleSources(capabilities), [capabilities]);
  const selectedEntries = useMemo(() => [...selected.values()], [selected]);
  const selectedNames = useMemo(
    () => selectedEntries.map((entry) => entry.name),
    [selectedEntries],
  );
  const fittingIntents = useMemo(
    () => intentsForSelection(selectedNames, capabilities),
    [selectedNames, capabilities],
  );
  const actingIntent = effectiveIntent(intent, selectedNames, capabilities);
  // Intents the OneDrive pane could ever offer this person; one that can
  // never apply is left out of the "Then" control instead of shown dead.
  const offeredIntents = useMemo(
    () =>
      ADD_INTENT_ORDER.filter((option) =>
        sourceServesIntent('onedrive', option, capabilities),
      ),
    [capabilities],
  );
  const extensions = useMemo(() => acceptedExtensions(intent), [intent]);

  const selectSource = (next: AddSourceId) => {
    if (next === 'camera') {
      // The camera is a capture flow of its own, not a pane.
      onOpenCamera();
      onClose();
      return;
    }
    setSource(next);
    setLastSource(next);
  };

  /** Acts on OneDrive / SharePoint files and closes the picker. */
  const actOnDriveItems = useCallback(
    (entries: M365DriveEntry[], chosen: AddIntent) => {
      if (entries.length === 0) return;
      if (chosen === 'translate') {
        onTranslateDriveItem(entries[0]);
      } else {
        // Attaching audio or video IS how it gets transcribed (on send), so
        // both intents attach. Each file continues in the background on its
        // own attachment tile.
        entries.forEach((entry) => void attachDriveItem(entry));
      }
      onClose();
    },
    [attachDriveItem, onTranslateDriveItem, onClose],
  );

  const handleSelectionChange = (next: Map<string, M365DriveEntry>) => {
    if (intent === 'translate' && next.size > 1) {
      // Translation takes one document: a second tick replaces the first.
      const added = [...next.entries()].filter(([key]) => !selected.has(key));
      setSelected(new Map(added.slice(-1)));
      return;
    }
    setSelected(next);
  };

  const handleActivate = (entry: M365DriveEntry) => {
    const chosen = effectiveIntent(intent, [entry.name], capabilities);
    if (chosen) actOnDriveItems([entry], chosen);
  };

  const deliverDeviceFiles = (files: File[]) => {
    if (files.length === 0) return;
    const usable = filesForIntent(files, intent);
    if (usable.length === 0) {
      toast.error(t('device.rejected'));
      return;
    }
    onDeviceFiles(usable, intent);
    onClose();
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    setIsDraggingFiles(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    // Leaving for a child element is not leaving the dialog.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsDraggingFiles(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    // The chat composer behind this dialog is a drop target too, and React
    // events bubble out of portals: without this the files attach twice.
    event.stopPropagation();
    setIsDraggingFiles(false);
    deliverDeviceFiles(Array.from(event.dataTransfer.files));
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    // Pasted text is left alone (the link field, search boxes).
    if (files.length === 0) return;
    event.preventDefault();
    // Same double-handling guard as the drop: the composer listens for
    // pasted images on the window.
    event.stopPropagation();
    deliverDeviceFiles(files);
  };

  const renderSourceButton = (candidate: AddSourceId): ReactNode => {
    const Icon = SOURCE_ICONS[candidate];
    const usable = sourceServesIntent(candidate, intent, capabilities);
    const active = candidate === source;
    return (
      <button
        key={candidate}
        type="button"
        ref={active ? keepInView : undefined}
        data-source-id={candidate}
        disabled={!usable}
        aria-current={active ? 'true' : undefined}
        title={usable ? undefined : t('sourceUnavailable')}
        onClick={() => selectSource(candidate)}
        className={`flex min-h-[40px] flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-start text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          active
            ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
            : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-neutral-700/60'
        }`}
      >
        <Icon size={18} className="flex-shrink-0" aria-hidden="true" />
        {t(`sources.${candidate}`)}
      </button>
    );
  };

  const firstM365Source = sources.find((candidate) =>
    M365_ADD_SOURCES.includes(candidate),
  );

  const pane: ReactNode = (() => {
    switch (source) {
      case 'onedrive':
        return (
          <M365FilePickerBody
            onClose={onClose}
            acceptExtensions={extensions}
            hosted={{
              selected,
              onChange: handleSelectionChange,
              onActivate: handleActivate,
            }}
          />
        );
      case 'mail':
        return <M365MailImportBody onClose={onClose} />;
      case 'meetings':
        return (
          <M365MeetingImportBody
            onClose={onClose}
            onImportTranscript={onImportTranscript}
          />
        );
      case 'link':
        return <UrlAttachForm onClose={onClose} />;
      default:
        // A page cannot list the device's files; the system dialog, a drop
        // and a paste are the only ways in.
        return (
          <div
            data-testid="add-to-chat-device"
            className="flex h-[420px] flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-gray-300 p-6 text-center dark:border-gray-600"
          >
            <IconUpload
              size={32}
              className="text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={() => onBrowseDevice(intent)}
              className={PRIMARY_BUTTON_CLASSES}
            >
              {t('device.browse')}
            </button>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('device.dropHint')}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-500">
              {t(`device.hint.${intent}`)}
            </p>
          </div>
        );
    }
  })();

  const showSelectionBar = source === 'onedrive' && selected.size > 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t(TITLE_KEYS[intent])}
      size="xl"
      // The close control sits inside the header: the default one hangs off
      // the panel's corner, which is off-screen on a full-screen phone sheet.
      closeWithButton={false}
      className="max-sm:min-h-dvh max-sm:max-w-none max-sm:rounded-none"
    >
      <div
        data-testid="add-to-chat"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
        className={`rounded-lg ${
          isDraggingFiles ? 'ring-2 ring-blue-500 ring-offset-4' : ''
        } ring-offset-white dark:ring-offset-surface-dark-base`}
      >
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:gap-4">
          {/* Sources: a column beside the pane, a scrolling strip on phones. */}
          <nav
            aria-label={t('sourcesLabel')}
            className="flex flex-shrink-0 gap-1 overflow-x-auto sm:w-52 sm:flex-col sm:overflow-visible"
          >
            {sources.map((candidate) =>
              candidate === firstM365Source
                ? [
                    <span
                      key="m365-label"
                      className="hidden px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 sm:block"
                    >
                      {t('microsoft365')}
                    </span>,
                    renderSourceButton(candidate),
                  ]
                : renderSourceButton(candidate),
            )}
          </nav>
          <div className="min-w-0 flex-1">{pane}</div>
        </div>

        {/* What happens to the ticked files. Only shown once something is
            ticked, and only with the actions that fit every ticked file. */}
        {showSelectionBar && (
          <div
            data-testid="add-to-chat-selection"
            className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-gray-200 pt-4 dark:border-gray-700"
          >
            <span className="whitespace-nowrap text-sm text-gray-700 dark:text-gray-300">
              {tPicker('selectedCount', { count: selected.size })}
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Map())}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
            >
              {tPicker('clearSelection')}
            </button>
            {offeredIntents.length > 1 && (
              <div className="flex items-center gap-2">
                <span
                  id="add-to-chat-then"
                  className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-400"
                >
                  {t('selection.then')}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="add-to-chat-then"
                  className="inline-flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600"
                >
                  {offeredIntents.map((option) => {
                    const fits = fittingIntents.includes(option);
                    const checked = option === actingIntent;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        disabled={!fits}
                        title={
                          fits ? undefined : t(`selection.unfit.${option}`)
                        }
                        onClick={() => setIntent(option)}
                        className={`min-h-[36px] whitespace-nowrap px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          checked
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-neutral-700'
                        }`}
                      >
                        {t(`selection.intents.${option}`)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="ms-auto flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className={QUIET_BUTTON_CLASSES}
              >
                {tRoot('Cancel')}
              </button>
              <button
                type="button"
                disabled={!actingIntent}
                onClick={() => {
                  if (actingIntent) {
                    actOnDriveItems(selectedEntries, actingIntent);
                  }
                }}
                className={PRIMARY_BUTTON_CLASSES}
              >
                {t(`selection.confirm.${actingIntent ?? 'attach'}`)}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};

/**
 * The single "Add to chat" picker: every place content can come from in one
 * dialog — this device, a link, the camera, and the Microsoft 365 sources
 * this person has — with the existing browsers hosted as panes.
 *
 * It only exists when there is a Microsoft 365 source to choose from; without
 * one the menu goes straight to the system file dialog (see `needsPicker`).
 *
 * The intent the picker was opened for (attach, translate, transcribe) sets
 * its title, which sources are usable and which files can be chosen. Ticking
 * OneDrive / SharePoint files reveals a "Then" control that can change it.
 */
const AddToChatDialog: FC<AddToChatDialogProps> = ({ isOpen, ...session }) =>
  isOpen ? <AddToChatSession {...session} /> : null;

export default AddToChatDialog;

import {
  IconBrandOnedrive,
  IconFolder,
  IconLoader2,
} from '@tabler/icons-react';
import { FC, FormEvent, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  M365SavePayload,
  buildBlob,
  destinationToTarget,
  showSavedToast,
} from '@/client/hooks/document/useM365Save';

import { saveToOneDrive } from '@/client/services/m365/m365Client';
import { m365ErrorKind } from '@/client/services/m365/m365ErrorKinds';

import type { M365SaveDestination } from '@/types/m365';

import M365FilePickerModal from '@/components/Chat/ChatInput/M365FilePickerModal';
import Modal from '@/components/UI/Modal';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface M365SaveDestinationModalProps {
  isOpen: boolean;
  onClose: () => void;
  payload: M365SavePayload | null;
}

/**
 * Errors span two namespaces (m365.save + m365.picker.errors) — keys are
 * kept namespaced instead of duplicating picker copy under m365.save.
 */
interface SaveErrorRef {
  ns: 'save' | 'pickerErrors';
  key: string;
}

function saveErrorRef(error: unknown): SaveErrorRef {
  switch (m365ErrorKind(error)) {
    case 'consentMissing':
      return { ns: 'save', key: 'consentMissing' };
    case 'notConnected':
      return { ns: 'pickerErrors', key: 'notConnected' };
    case 'network':
      return { ns: 'pickerErrors', key: 'network' };
    case 'rateLimited':
      return { ns: 'pickerErrors', key: 'rateLimited' };
    case 'notFound':
      return { ns: 'save', key: 'destinationMissing' };
    case 'forbidden':
      return { ns: 'save', key: 'destinationForbidden' };
    default:
      return { ns: 'save', key: 'failed' };
  }
}

/**
 * Compact "where should this go?" step for Save to OneDrive: editable file
 * name, current destination with a Change… hand-off to the folder picker,
 * and the "always save here" opt-out of this dialog. The upload itself runs
 * here so failures render inline and the dialog can stay open for a retry.
 */
const M365SaveDestinationBody: FC<{
  payload: M365SavePayload;
  onClose: () => void;
}> = ({ payload, onClose }) => {
  const t = useTranslations('m365.save');
  const tPickerErrors = useTranslations('m365.picker.errors');
  const setM365SaveDestination = useSettingsStore(
    (s) => s.setM365SaveDestination,
  );
  const setM365SaveSkipPicker = useSettingsStore(
    (s) => s.setM365SaveSkipPicker,
  );

  const [fileName, setFileName] = useState(
    `${payload.baseFileName}.${payload.format}`,
  );
  // Picked destination stays local until a successful save — Cancel discards.
  const [destination, setDestination] = useState<M365SaveDestination | null>(
    () => useSettingsStore.getState().m365SaveDestination,
  );
  const [remember, setRemember] = useState(
    () => useSettingsStore.getState().m365SaveSkipPicker,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SaveErrorRef | null>(null);
  // Closing during an in-flight save unmounts this body, but the upload
  // keeps running. Its outcome must stay visible: success already toasts
  // (showSavedToast is mount-independent), and a failure after close is
  // routed to a toast instead of the now-unmounted inline error.
  const closedRef = useRef(false);

  const handleClose = () => {
    closedRef.current = true;
    onClose();
  };

  const trimmedName = fileName.trim();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmedName || saving) return;
    // A name typed without an extension still gets the chosen format's one.
    const finalName = /\.[^.]+$/.test(trimmedName)
      ? trimmedName
      : `${trimmedName}.${payload.format}`;
    setSaving(true);
    setError(null);
    try {
      const blob = await buildBlob(
        payload.format,
        payload.html,
        payload.markdownSource,
      );
      const result = await saveToOneDrive(
        blob,
        finalName,
        destinationToTarget(destination),
      );
      if (destination !== useSettingsStore.getState().m365SaveDestination) {
        setM365SaveDestination(destination);
      }
      setM365SaveSkipPicker(remember);
      showSavedToast({
        // The server-returned name reflects a conflict-rename.
        message: t('savedTo', {
          name: result.name,
          folder: destination?.pathLabel ?? t('defaultFolderPath'),
        }),
        openLabel: t('open'),
        webUrl: result.webUrl,
      });
      onClose();
    } catch (saveError) {
      const ref = saveErrorRef(saveError);
      if (closedRef.current) {
        toast.error(ref.ns === 'save' ? t(ref.key) : tPickerErrors(ref.key));
      } else {
        setError(ref);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Never stacked: the save dialog hides (state intact) while the
          folder picker is open, and returns when it picks or closes. */}
      <Modal
        isOpen={!pickerOpen}
        onClose={handleClose}
        title={t('dialogTitle')}
        icon={<IconBrandOnedrive size={20} />}
        size="md"
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
              {error.ns === 'save' ? t(error.key) : tPickerErrors(error.key)}
            </p>
          )}

          <div className="flex flex-col gap-1">
            <label
              htmlFor="m365-save-filename"
              className="text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('fileNameLabel')}
            </label>
            <input
              id="m365-save-filename"
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              autoFocus
              aria-invalid={!trimmedName}
              aria-describedby={
                trimmedName ? undefined : 'm365-save-filename-error'
              }
              className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
            />
            {!trimmedName && (
              <p
                id="m365-save-filename-error"
                role="alert"
                className="text-xs text-amber-700 dark:text-amber-400"
              >
                {t('fileNameRequired')}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('destinationLabel')}
            </span>
            <div className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700">
              <IconFolder size={18} className="flex-shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-gray-800 dark:text-gray-200">
                  {destination?.name ?? t('defaultFolderName')}
                </p>
                <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                  {destination?.pathLabel ?? t('defaultFolderPath')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="flex-shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
              >
                {t('changeFolder')}
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
            />
            {t('rememberFolder')}
          </label>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={!trimmedName || saving}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <IconLoader2 size={14} className="animate-spin" />}
              {t('saveButton')}
            </button>
          </div>
        </form>
      </Modal>

      <M365FilePickerModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPickFolder={(picked) => {
          setDestination(picked);
          setPickerOpen(false);
        }}
      />
    </>
  );
};

const M365SaveDestinationModal: FC<M365SaveDestinationModalProps> = ({
  isOpen,
  onClose,
  payload,
}) => {
  // Body mounts fresh per opening: the file name, locally picked folder and
  // checkbox all reset to their stored values on the next save.
  if (!isOpen || !payload) return null;
  return <M365SaveDestinationBody payload={payload} onClose={onClose} />;
};

export default M365SaveDestinationModal;

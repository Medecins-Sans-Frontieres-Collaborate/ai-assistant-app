'use client';

import {
  IconAlertTriangle,
  IconDownload,
  IconPencil,
  IconPlus,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  AdminSkillEntry,
  SkillSaveConflict,
  useSkillsAdmin,
} from '@/client/hooks/settings/useSkillsAdmin';

import { parseSkillBundle } from '@/lib/services/skills/skillBundle';
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from '@/lib/services/skills/skillMarkdown';
import {
  SKILL_LIMITS,
  SkillActivation,
  SkillIdSchema,
  SkillWriteFields,
} from '@/lib/services/skills/types';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_CHIP_WARN,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';

import { SkillDocuments } from './SkillDocuments';
import { SkillSources } from './SkillSources';

/**
 * Admin → Skills (docs/SKILLS_DESIGN.md §4): list, editor, SKILL.md
 * import/export. Built-ins render with provenance chips; editing one stores
 * an override record, deleting the override restores the compiled default.
 */

interface DraftState {
  files?: File[];
  /** Stored etag for PUT; null = create (new skill or first override). */
  etag: string | null;
  /** The id being edited; null = new skill (id editable). */
  existingId: string | null;
  builtin: boolean;
  fields: SkillWriteFields;
}

const EMPTY_FIELDS: SkillWriteFields = {
  id: '',
  name: '',
  description: '',
  activation: 'auto',
  applyToAgents: false,
  requireConsent: false,
  instructions: '',
};

const ACTIVATIONS: SkillActivation[] = ['auto', 'always', 'manual', 'off'];

export const SkillsPanel: FC = () => {
  const t = useTranslations('skillsAdmin');
  const { query, save, remove } = useSkillsAdmin();

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [isConflict, setIsConflict] = useState(false);
  const [managedId, setManagedId] = useState<string | null>(null);
  const [skippedFiles, setSkippedFiles] = useState<string[]>([]);

  const entries = query.data?.skills ?? [];
  const alwaysCount = entries.filter(
    (entry) => entry.skill.activation === 'always',
  ).length;

  const startNew = () => {
    setSkippedFiles([]);
    setIsConflict(false);
    setDraft({
      etag: null,
      existingId: null,
      builtin: false,
      fields: { ...EMPTY_FIELDS },
    });
  };

  const startEdit = (entry: AdminSkillEntry) => {
    setSkippedFiles([]);
    setIsConflict(false);
    setDraft({
      etag: entry.etag,
      existingId: entry.skill.id,
      builtin: entry.builtin,
      fields: {
        id: entry.skill.id,
        name: entry.skill.name,
        description: entry.skill.description,
        activation: entry.skill.activation,
        applyToAgents: entry.skill.applyToAgents,
        requireConsent: entry.skill.requireConsent ?? false,
        instructions: entry.skill.instructions,
        ...(entry.skill.foreignFrontmatter
          ? { foreignFrontmatter: entry.skill.foreignFrontmatter }
          : {}),
      },
    });
  };

  const handleImportParse = () => {
    setSkippedFiles([]);
    const parsed = parseSkillMarkdown(importText);
    if (!parsed.ok) {
      setImportErrors(parsed.errors);
      return;
    }
    setImportErrors([]);
    setImportOpen(false);
    setImportText('');
    setIsConflict(false);
    // Imported content ALWAYS lands in the editor for review before any
    // save — the full body is visible, never silently stored
    // (docs/SKILLS_DESIGN.md §6 trust model).
    setDraft({
      etag: null,
      existingId: null,
      builtin: false,
      fields: {
        id: parsed.skill.id,
        name: parsed.skill.name,
        description: parsed.skill.description,
        activation: parsed.skill.activation,
        applyToAgents: parsed.skill.applyToAgents,
        requireConsent: parsed.skill.requireConsent ?? false,
        instructions: parsed.skill.instructions,
        ...(parsed.skill.foreignFrontmatter
          ? { foreignFrontmatter: parsed.skill.foreignFrontmatter }
          : {}),
      },
    });
  };

  const importZip = async (file: File) => {
    try {
      if (file.size > SKILL_LIMITS.maxBundleBytes)
        throw new Error(t('documents.zipTooLarge'));
      const bundle = parseSkillBundle(new Uint8Array(await file.arrayBuffer()));
      setDraft({
        etag: null,
        existingId: null,
        builtin: false,
        fields: {
          ...bundle.skill,
          requireConsent: bundle.skill.requireConsent ?? false,
        },
        files: bundle.resources.map(
          (resource) =>
            new File([new Uint8Array(resource.bytes)], resource.path),
        ),
      });
      setSkippedFiles(bundle.skipped);
      setImportErrors([]);
      setImportOpen(false);
    } catch (error) {
      setImportErrors([
        error instanceof Error ? error.message : t('documents.requestFailed'),
      ]);
    }
  };

  const handleExport = (entry: AdminSkillEntry) => {
    if (entry.skill.documents.length) {
      const anchor = document.createElement('a');
      anchor.href = `/api/agent-access/skills/${entry.skill.id}/bundle`;
      anchor.download = `${entry.skill.id}.zip`;
      anchor.click();
      return;
    }
    const markdown = serializeSkillMarkdown({
      id: entry.skill.id,
      name: entry.skill.name,
      description: entry.skill.description,
      instructions: entry.skill.instructions,
      activation: entry.skill.activation,
      applyToAgents: entry.skill.applyToAgents,
      requireConsent: entry.skill.requireConsent ?? false,
      foreignFrontmatter: entry.skill.foreignFrontmatter,
    });
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${entry.skill.id}.SKILL.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleSave = async () => {
    if (!draft) return;
    const idCheck = SkillIdSchema.safeParse(draft.fields.id);
    if (!idCheck.success) {
      toast.error(t('invalidId'));
      return;
    }
    try {
      const saved = await save.mutateAsync({
        fields: draft.fields,
        etag: draft.etag,
        files: draft.files,
      });
      if (draft.files?.length) setManagedId(saved.skill.id);
      setDraft(null);
      toast.success(t('saveSuccess'));
    } catch (error) {
      if (error instanceof SkillSaveConflict) {
        setIsConflict(true);
        query.refetch();
        return;
      }
      toast.error(t('saveError'));
    }
  };

  const handleDelete = async (entry: AdminSkillEntry) => {
    if (!entry.etag) return; // compiled default — nothing stored to delete
    const confirmed = window.confirm(
      entry.builtin ? t('restoreConfirm') : t('deleteConfirm'),
    );
    if (!confirmed) return;
    try {
      await remove.mutateAsync({ id: entry.skill.id, etag: entry.etag });
      if (draft?.existingId === entry.skill.id) setDraft(null);
      toast.success(entry.builtin ? t('restoreSuccess') : t('deleteSuccess'));
    } catch (error) {
      if (error instanceof SkillSaveConflict) {
        setIsConflict(true);
        query.refetch();
        return;
      }
      toast.error(t('deleteError'));
    }
  };

  if (query.isLoading) {
    return <p className={ADMIN_MUTED}>{t('loading')}</p>;
  }

  if (query.isError) {
    return (
      <div className="space-y-3">
        <div className={ADMIN_BANNER_ERROR}>{t('loadError')}</div>
        <button className={ADMIN_BTN_RETRY} onClick={() => query.refetch()}>
          {t('retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-black dark:text-white">
            {t('title')}
          </h1>
          <p className={ADMIN_MUTED}>{t('description')}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className={ADMIN_BTN_SECONDARY}
            onClick={() => {
              setImportOpen((open) => !open);
              setImportErrors([]);
            }}
          >
            <IconUpload size={16} />
            {t('importSkill')}
          </button>
          <button className={ADMIN_BTN_PRIMARY} onClick={startNew}>
            <span className="flex items-center gap-1.5">
              <IconPlus size={16} />
              {t('newSkill')}
            </span>
          </button>
        </div>
      </div>

      {query.data?.skillsUnavailable && (
        <div className={ADMIN_BANNER_WARN}>
          <span className="flex items-center gap-2">
            <IconAlertTriangle size={16} />
            {t('unavailableBanner')}
          </span>
        </div>
      )}

      {isConflict && (
        <div className={ADMIN_BANNER_WARN}>{t('conflictError')}</div>
      )}

      {alwaysCount > 2 && (
        <div className={ADMIN_BANNER_WARN}>
          {t('alwaysWarning', { count: alwaysCount })}
        </div>
      )}

      {importOpen && (
        <div className={ADMIN_ROW}>
          <label className={ADMIN_LABEL}>
            {t('documents.importZip')}
            <input
              type="file"
              accept=".zip"
              className={`${ADMIN_FIELD} mt-1 block w-full`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importZip(file);
              }}
            />
          </label>
          <label className={ADMIN_LABEL} htmlFor="skill-import">
            {t('importTitle')}
          </label>
          <textarea
            id="skill-import"
            className={`${ADMIN_FIELD} h-40 w-full font-mono`}
            placeholder={t('importPlaceholder')}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
          />
          <p className={ADMIN_HINT}>{t('importHint')}</p>
          {importErrors.length > 0 && (
            <ul className={`${ADMIN_BANNER_ERROR} mt-2 list-inside list-disc`}>
              {importErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          <div className="mt-2">
            <button
              className={ADMIN_BTN_PRIMARY}
              onClick={handleImportParse}
              disabled={!importText.trim()}
            >
              {t('importParse')}
            </button>
          </div>
        </div>
      )}

      {draft && (
        <>
          {!!draft.files?.length && (
            <p className={ADMIN_HINT}>
              {t('documents.importCount', { count: draft.files.length })}:{' '}
              {draft.files.map((file) => file.name).join(', ')}
            </p>
          )}
          {!!skippedFiles.length && (
            <p className={ADMIN_BANNER_WARN}>
              {t('documents.skippedScripts')}: {skippedFiles.join(', ')}
            </p>
          )}
          <SkillEditor
            draft={draft}
            onChange={setDraft}
            onSave={handleSave}
            onCancel={() => setDraft(null)}
            saving={save.isPending}
          />
        </>
      )}

      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.skill.id} className={ADMIN_ROW}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-black dark:text-white">
                    {entry.skill.name}
                  </span>
                  <code className={ADMIN_CHIP_NEUTRAL}>{entry.skill.id}</code>
                  <span className={ADMIN_CHIP_NEUTRAL}>
                    {t(`activation.${entry.skill.activation}`)}
                  </span>
                  {entry.builtin && (
                    <span className={ADMIN_CHIP_NEUTRAL}>
                      {t('builtinChip')}
                    </span>
                  )}
                  {entry.overridden && (
                    <span className={ADMIN_CHIP_WARN}>
                      {t('customizedChip')}
                    </span>
                  )}
                  {entry.skill.requireConsent && (
                    <span className={ADMIN_CHIP_NEUTRAL}>
                      {t('consentChip')}
                    </span>
                  )}
                  {entry.skill.source && (
                    <span
                      className={ADMIN_CHIP_NEUTRAL}
                      title={t('sourceChipHint')}
                    >
                      {t('sourceChip')}
                    </span>
                  )}
                </div>
                <p className={`${ADMIN_MUTED} mt-1 truncate`}>
                  {entry.skill.description}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className={ADMIN_BTN_SECONDARY}
                  onClick={() =>
                    setManagedId(
                      managedId === entry.skill.id ? null : entry.skill.id,
                    )
                  }
                  aria-expanded={managedId === entry.skill.id}
                >
                  {t('documents.title')} ({entry.skill.documents.length})
                </button>
                <button
                  className={ADMIN_BTN_SECONDARY}
                  onClick={() => handleExport(entry)}
                  title={t('exportSkill')}
                >
                  <IconDownload size={16} />
                </button>
                <button
                  className={ADMIN_BTN_SECONDARY}
                  onClick={() => startEdit(entry)}
                  disabled={entry.editable === false}
                  title={t('edit')}
                >
                  <IconPencil size={16} />
                </button>
                {entry.etag && entry.editable !== false && (
                  <button
                    className={ADMIN_BTN_ICON_DANGER}
                    onClick={() => handleDelete(entry)}
                    title={entry.builtin ? t('restoreDefault') : t('delete')}
                  >
                    <IconTrash size={16} />
                  </button>
                )}
              </div>
            </div>
            {managedId === entry.skill.id && (
              <SkillDocuments entry={entry} refresh={() => query.refetch()} />
            )}
          </div>
        ))}
        {entries.length === 0 && <p className={ADMIN_MUTED}>{t('empty')}</p>}
      </div>
      <SkillSources />
    </div>
  );
};

const SkillEditor: FC<{
  draft: DraftState;
  onChange: (draft: DraftState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}> = ({ draft, onChange, onSave, onCancel, saving }) => {
  const t = useTranslations('skillsAdmin');
  const setField = <K extends keyof SkillWriteFields>(
    key: K,
    value: SkillWriteFields[K],
  ) => onChange({ ...draft, fields: { ...draft.fields, [key]: value } });

  return (
    <div className={`${ADMIN_ROW} space-y-3`}>
      <h2 className="text-sm font-semibold text-black dark:text-white">
        {draft.existingId
          ? t('editTitle', { name: draft.fields.name || draft.existingId })
          : t('createTitle')}
      </h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={ADMIN_LABEL} htmlFor="skill-id">
            {t('idLabel')}
          </label>
          <input
            id="skill-id"
            className={`${ADMIN_FIELD} w-full font-mono`}
            value={draft.fields.id}
            maxLength={SKILL_LIMITS.idMaxLength}
            // The id is the record's identity (blob path, canonical key,
            // SKILL.md name) — frozen once created.
            disabled={draft.existingId !== null}
            onChange={(event) =>
              setField('id', event.target.value.toLowerCase())
            }
          />
          <p className={ADMIN_HINT}>{t('idHint')}</p>
        </div>
        <div>
          <label className={ADMIN_LABEL} htmlFor="skill-name">
            {t('nameLabel')}
          </label>
          <input
            id="skill-name"
            className={`${ADMIN_FIELD} w-full`}
            value={draft.fields.name}
            maxLength={SKILL_LIMITS.nameMaxLength}
            onChange={(event) => setField('name', event.target.value)}
          />
        </div>
      </div>

      <div>
        <label className={ADMIN_LABEL} htmlFor="skill-description">
          {t('descriptionLabel')}
        </label>
        <textarea
          id="skill-description"
          className={`${ADMIN_FIELD} h-20 w-full`}
          value={draft.fields.description}
          maxLength={SKILL_LIMITS.descriptionMaxLength}
          onChange={(event) => setField('description', event.target.value)}
        />
        <p className={ADMIN_HINT}>{t('descriptionHint')}</p>
      </div>

      <div>
        <label className={ADMIN_LABEL} htmlFor="skill-activation">
          {t('activationLabel')}
        </label>
        <select
          id="skill-activation"
          className={ADMIN_FIELD}
          value={draft.fields.activation}
          onChange={(event) =>
            setField('activation', event.target.value as SkillActivation)
          }
        >
          {ACTIVATIONS.map((activation) => (
            <option key={activation} value={activation}>
              {t(`activation.${activation}`)}
            </option>
          ))}
        </select>
        <p className={ADMIN_HINT}>
          {t(`activationHint.${draft.fields.activation}`)}
        </p>
      </div>

      <div>
        <label className={ADMIN_LABEL} htmlFor="skill-instructions">
          {t('instructionsLabel')}
        </label>
        <textarea
          id="skill-instructions"
          className={`${ADMIN_FIELD} h-64 w-full font-mono`}
          value={draft.fields.instructions}
          onChange={(event) => setField('instructions', event.target.value)}
        />
        <p className={ADMIN_HINT}>{t('instructionsHint')}</p>
      </div>
      <div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            className={ADMIN_CHECKBOX}
            checked={draft.fields.applyToAgents}
            onChange={(event) =>
              setField('applyToAgents', event.target.checked)
            }
          />
          {t('applyToAgents')}
        </label>
        <p className={ADMIN_HINT}>{t('applyToAgentsHint')}</p>
      </div>
      <div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            className={ADMIN_CHECKBOX}
            checked={draft.fields.requireConsent}
            onChange={(event) =>
              setField('requireConsent', event.target.checked)
            }
          />
          {t('requireConsent')}
        </label>
        <p className={ADMIN_HINT}>{t('requireConsentHint')}</p>
      </div>

      <div className="flex gap-2">
        <button
          className={ADMIN_BTN_PRIMARY}
          onClick={onSave}
          disabled={
            saving ||
            !draft.fields.id ||
            !draft.fields.name.trim() ||
            !draft.fields.description.trim() ||
            !draft.fields.instructions.trim()
          }
        >
          {saving ? t('saving') : t('save')}
        </button>
        <button className={ADMIN_BTN_SECONDARY} onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
};

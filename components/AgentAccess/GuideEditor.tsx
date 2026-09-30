'use client';

import { IconSparkles } from '@tabler/icons-react';
import { FC, useCallback, useEffect, useId, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

// Type-only: lib/services/agentAccess/types.ts pulls in node modules.
import type { Guide } from '@/lib/services/agentAccess/types';

import {
  MAX_GUIDE_BODY_CHARS,
  MAX_GUIDE_ENTRIES,
  MAX_GUIDE_NAME_CHARS,
  MAX_GUIDE_SECTIONS,
  MAX_GUIDE_VOICE_CHARS,
} from '@/lib/utils/shared/review/guideCriteria';
import {
  TRANSLATION_LANGUAGES,
  translationLanguageLabel,
} from '@/lib/utils/shared/translation/languages';

import { DocumentSpecSection, GlossaryEntry } from '@/types/workflow';

import { GlossaryEntriesEditor } from '../Workflows/Shared/GlossaryEntriesEditor';
import { SpecFieldsEditor } from '../Workflows/Shared/SpecFieldsEditor';
import { ChipListInput } from './ChipListInput';
import { AdminStoredGuide } from './types';

interface GuideEditorProps {
  /** null = create (POST); otherwise edit (PUT with If-Match). */
  existing: AdminStoredGuide | null;
  onSaved: () => void;
  onCancel: () => void;
  /** 409 conflict acknowledged — parent refetches and closes. */
  onConflictReload: () => void;
  /**
   * 'glossary' pins the kind to terminology, hides the kind selector, and
   * uses glossary wording — the Admin → Glossaries area. The stored record
   * is the same terminology guide either way.
   */
  variant?: 'guide' | 'glossary';
}

type GuideKind = 'style' | 'terminology' | 'compliance' | 'structure' | 'tone';

const GUIDE_KINDS: GuideKind[] = [
  'style',
  'terminology',
  'compliance',
  'structure',
  'tone',
];

/** The kinds pinned to the document workflow (spec/tone slot fillers). */
const DOCUMENT_ONLY_KINDS: ReadonlySet<GuideKind> = new Set([
  'structure',
  'tone',
]);

/** Kind badge colors — the visual differentiation between guide families. */
const KIND_BADGE_CLASSES: Record<GuideKind, string> = {
  style: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  compliance:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  terminology:
    'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  structure:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  tone: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300',
};

/** Fields AI fill can return; toggles are keyed on these names. */
interface GeneratedFields {
  name?: string;
  description?: string;
  body?: string;
  voiceRules?: string;
  examples?: string;
  sections?: DocumentSpecSection[];
  generalGuidance?: string;
  entries?: GlossaryEntry[];
}

type FieldKey = keyof GeneratedFields;

/**
 * Inline create/edit card for one admin-authored workflow guide, with a
 * kind-specific sub-form: style/compliance edit a markdown body; tone edits
 * voice rules + examples (the ToneInput shape); structure edits spec
 * sections through the same SpecFieldsEditor the SpecManager uses;
 * terminology edits glossary entries through the same GlossaryEntriesEditor
 * the GlossaryManager uses. Follows the ConnectorEditor idiom: bordered
 * card, Cancel/Save footer, 409 → conflict banner + reload, remounted by
 * the parent on etag change.
 *
 * The kind is LOCKED once created — the payload shape, slot eligibility,
 * and prompt semantics all hang off it (the server rejects a change too).
 *
 * AI fill: a prompt generates kind-shaped fields server-side; fields the
 * form already has content for are only overwritten when their toggle is
 * checked (default keep), empty fields always fill. Nothing reaches the
 * server until the normal Save.
 */
export const GuideEditor: FC<GuideEditorProps> = ({
  existing,
  onSaved,
  onCancel,
  onConflictReload,
  variant = 'guide',
}) => {
  const t = useTranslations('agentAccess');
  const isGlossary = variant === 'glossary';

  const [name, setName] = useState(existing?.guide.name ?? '');
  const [description, setDescription] = useState(
    existing?.guide.description ?? '',
  );
  const [kind, setKind] = useState<GuideKind>(
    existing?.guide.kind ?? (isGlossary ? 'terminology' : 'style'),
  );
  const [workflows, setWorkflows] = useState<Array<'document' | 'translation'>>(
    existing?.guide.workflows ??
      (isGlossary ? ['translation', 'document'] : ['document']),
  );
  const [languages, setLanguages] = useState<string[]>(
    existing?.guide.languages ?? [],
  );
  const [sourceLang, setSourceLang] = useState(
    existing?.guide.sourceLang ?? '',
  );
  const [targetLang, setTargetLang] = useState(
    existing?.guide.targetLang ?? '',
  );
  const [body, setBody] = useState(existing?.guide.body ?? '');
  const [voiceRules, setVoiceRules] = useState(
    existing?.guide.voiceRules ?? '',
  );
  const [examples, setExamples] = useState(existing?.guide.examples ?? '');
  const [sections, setSections] = useState<DocumentSpecSection[]>(
    existing?.guide.sections ?? [],
  );
  const [generalGuidance, setGeneralGuidance] = useState(
    existing?.guide.generalGuidance ?? '',
  );
  const [entries, setEntries] = useState<GlossaryEntry[]>(
    existing?.guide.entries ?? [],
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * SPLIT STORAGE: the admin listing serves META only, so a guide whose
   * payload lives in an external blob loads it here on open. Saving is
   * blocked until it lands — an empty form saved over a real payload would
   * be data loss.
   */
  const needsPayloadLoad =
    existing !== null && existing.guide.payloadRef !== undefined;
  const [payloadLoading, setPayloadLoading] = useState(needsPayloadLoad);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [payloadAttempt, setPayloadAttempt] = useState(0);

  useEffect(() => {
    if (!needsPayloadLoad || !existing) return;
    let cancelled = false;
    setPayloadLoading(true);
    setPayloadError(null);
    void (async () => {
      try {
        const response = await fetch(
          `/api/agent-access/guides/${encodeURIComponent(existing.guide.id)}`,
        );
        if (cancelled) return;
        if (response.status === 404) {
          // Deleted since the listing loaded — same dead end as a PUT 404.
          setIsConflict(true);
          return;
        }
        const json = (await response.json().catch(() => ({}))) as {
          data?: { guide?: Partial<Guide>; payloadMissing?: boolean };
          error?: unknown;
        };
        if (!response.ok || !json.data?.guide) {
          setPayloadError(
            typeof json.error === 'string' ? json.error : t('loadError'),
          );
          return;
        }
        if (cancelled) return;
        const loaded = json.data.guide;
        setBody(loaded.body ?? '');
        setVoiceRules(loaded.voiceRules ?? '');
        setExamples(loaded.examples ?? '');
        setSections(loaded.sections ?? []);
        setGeneralGuidance(loaded.generalGuidance ?? '');
        setEntries(loaded.entries ?? []);
        if (json.data.payloadMissing) {
          // The meta exists but its blob is gone; the form opens empty and
          // a save writes a fresh payload. Say so instead of hiding it.
          toast.error(t('guidePayloadMissing'));
        }
        setPayloadLoading(false);
      } catch {
        if (!cancelled) setPayloadError(t('loadError'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `existing` is remounted by the parent on etag change; the attempt
    // counter drives explicit retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPayloadLoad, existing?.guide.id, existing?.etag, payloadAttempt]);

  /** Catalog languages, sorted by display label, for the pair selects. */
  const languageOptions = useMemo(
    () =>
      TRANSLATION_LANGUAGES.map((lang) => ({
        id: lang.id,
        label: translationLanguageLabel(lang),
      })).sort((a, b) => a.label.localeCompare(b.label)),
    [],
  );
  const retryPayloadLoad = useCallback(
    () => setPayloadAttempt((attempt) => attempt + 1),
    [],
  );

  const [aiPrompt, setAiPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [pendingFields, setPendingFields] = useState<GeneratedFields | null>(
    null,
  );
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({});

  const baseId = useId();

  const documentOnly = DOCUMENT_ONLY_KINDS.has(kind);
  // Mirrors the server's cross-field rule: structure/tone ⇒ document only.
  const effectiveWorkflows: Array<'document' | 'translation'> = documentOnly
    ? ['document']
    : workflows;

  const changeKind = (next: GuideKind) => {
    setKind(next);
    setPendingFields(null);
    if (DOCUMENT_ONLY_KINDS.has(next)) setWorkflows(['document']);
  };

  const toggleWorkflow = (workflow: 'document' | 'translation') => {
    setWorkflows((prev) =>
      prev.includes(workflow)
        ? prev.filter((w) => w !== workflow)
        : [...prev, workflow],
    );
  };

  /** Current value + emptiness per AI-fillable field, for the apply merge. */
  const currentFieldValue = (
    key: FieldKey,
  ): { value: unknown; empty: boolean } => {
    switch (key) {
      case 'name':
        return { value: name, empty: name.trim() === '' };
      case 'description':
        return { value: description, empty: description.trim() === '' };
      case 'body':
        return { value: body, empty: body.trim() === '' };
      case 'voiceRules':
        return { value: voiceRules, empty: voiceRules.trim() === '' };
      case 'examples':
        return { value: examples, empty: examples.trim() === '' };
      case 'sections':
        return { value: sections, empty: sections.length === 0 };
      case 'generalGuidance':
        return {
          value: generalGuidance,
          empty: generalGuidance.trim() === '',
        };
      case 'entries':
        return { value: entries, empty: entries.length === 0 };
    }
  };

  const setFieldValue = (key: FieldKey, value: unknown) => {
    switch (key) {
      case 'name':
        setName(value as string);
        break;
      case 'description':
        setDescription(value as string);
        break;
      case 'body':
        setBody(value as string);
        break;
      case 'voiceRules':
        setVoiceRules(value as string);
        break;
      case 'examples':
        setExamples(value as string);
        break;
      case 'sections':
        setSections(value as DocumentSpecSection[]);
        break;
      case 'generalGuidance':
        setGeneralGuidance((value as string) ?? '');
        break;
      case 'entries':
        setEntries(value as GlossaryEntry[]);
        break;
    }
  };

  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setIsGenerating(true);
    setAiError(null);
    setPendingFields(null);
    try {
      const current: Record<string, unknown> = {};
      if (name.trim()) current.name = name;
      if (description.trim()) current.description = description;
      if (kind === 'style' || kind === 'compliance') {
        if (body.trim()) current.body = body;
      } else if (kind === 'tone') {
        if (voiceRules.trim()) current.voiceRules = voiceRules;
        if (examples.trim()) current.examples = examples;
      } else if (kind === 'structure') {
        if (sections.length > 0) current.sections = sections;
        if (generalGuidance.trim()) current.generalGuidance = generalGuidance;
      } else if (kind === 'terminology') {
        if (entries.length > 0) current.entries = entries;
      }

      const response = await fetch('/api/agent-access/guides/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, prompt: aiPrompt.trim(), current }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        data?: { fields?: GeneratedFields };
      };
      if (!response.ok || !json.data?.fields) {
        setAiError(
          typeof json.error === 'string' ? json.error : t('guideAiFailed'),
        );
        return;
      }
      // Drop fields the model returned empty/absent — they offer nothing to
      // apply, so a toggle for them would be noise.
      const fields = Object.fromEntries(
        Object.entries(json.data.fields).filter(([, value]) =>
          Array.isArray(value) ? value.length > 0 : value !== undefined,
        ),
      ) as GeneratedFields;
      if (Object.keys(fields).length === 0) {
        setAiError(t('guideAiEmpty'));
        return;
      }
      setPendingFields(fields);
      // Non-empty current fields default to KEEP; the toggle opts into
      // overwriting.
      setOverwrite({});
    } catch {
      setAiError(t('guideAiFailed'));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleApplyGenerated = () => {
    if (!pendingFields) return;
    for (const [key, value] of Object.entries(pendingFields)) {
      const fieldKey = key as FieldKey;
      const { empty } = currentFieldValue(fieldKey);
      if (empty || overwrite[fieldKey]) {
        setFieldValue(fieldKey, value);
      }
    }
    setPendingFields(null);
    setAiPrompt('');
  };

  const bodyOverBy = body.length - MAX_GUIDE_BODY_CHARS;
  const voiceRulesOverBy = voiceRules.length - MAX_GUIDE_VOICE_CHARS;
  const payloadValid = (() => {
    switch (kind) {
      case 'style':
      case 'compliance':
        return body.length > 0 && bodyOverBy <= 0;
      case 'tone':
        return (
          voiceRules.length > 0 &&
          voiceRulesOverBy <= 0 &&
          examples.length <= MAX_GUIDE_VOICE_CHARS
        );
      case 'structure':
        return (
          sections.length > 0 &&
          sections.length <= MAX_GUIDE_SECTIONS &&
          sections.every((s) => s.heading.trim() !== '')
        );
      case 'terminology':
        return entries.length > 0 && entries.length <= MAX_GUIDE_ENTRIES;
    }
  })();
  const canSave =
    name.trim().length > 0 &&
    name.trim().length <= MAX_GUIDE_NAME_CHARS &&
    payloadValid &&
    effectiveWorkflows.length > 0 &&
    !payloadLoading &&
    payloadError === null;

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (kind === 'style' || kind === 'compliance') {
        payload.body = body;
      } else if (kind === 'tone') {
        payload.voiceRules = voiceRules;
        if (examples) payload.examples = examples;
      } else if (kind === 'structure') {
        payload.sections = sections.map((s) => ({
          heading: s.heading,
          ...(s.guidance ? { guidance: s.guidance } : {}),
          required: s.required,
        }));
        if (generalGuidance) payload.generalGuidance = generalGuidance;
      } else if (kind === 'terminology') {
        payload.entries = entries;
        if (sourceLang) payload.sourceLang = sourceLang;
        if (targetLang) payload.targetLang = targetLang;
      }

      const response = await fetch('/api/agent-access/guides', {
        method: existing ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(existing ? { 'If-Match': existing.etag } : {}),
        },
        body: JSON.stringify({
          ...(existing ? { id: existing.guide.id } : {}),
          name: name.trim(),
          description: description.trim(),
          kind,
          languages,
          ...payload,
          workflows: effectiveWorkflows,
        }),
      });
      if (response.status === 409) {
        setIsConflict(true);
        return;
      }
      // Update-path 404: deleted while this editor was open. A PUT can never
      // mint a new record, so retrying is a dead end — route it to the
      // conflict banner whose Reload drops the stale row.
      if (existing && response.status === 404) {
        setIsConflict(true);
        return;
      }
      if (!response.ok) {
        const responseBody = (await response.json().catch(() => ({}))) as {
          error?: unknown;
        };
        setSaveError(
          typeof responseBody.error === 'string'
            ? responseBody.error
            : t('saveError'),
        );
        return;
      }
      toast.success(
        t(
          existing
            ? isGlossary
              ? 'glossarySaveSuccess'
              : 'guideSaveSuccess'
            : isGlossary
              ? 'glossaryCreateSuccess'
              : 'guideCreateSuccess',
        ),
      );
      onSaved();
    } catch {
      setSaveError(t('saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500';
  const labelClass =
    'mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300';

  if (isConflict) {
    return (
      <div className="mt-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
        <p>{t('conflictError')}</p>
        <button
          type="button"
          className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
          onClick={onConflictReload}
        >
          {t('reload')}
        </button>
      </div>
    );
  }

  /** One keep/overwrite row in the AI pending panel. */
  const renderPendingField = (key: FieldKey) => {
    if (!pendingFields || pendingFields[key] === undefined) return null;
    const { empty } = currentFieldValue(key);
    const generated = pendingFields[key];
    const preview = Array.isArray(generated)
      ? t('guideAiListPreview', { count: String(generated.length) })
      : String(generated).length > 120
        ? `${String(generated).slice(0, 120)}…`
        : String(generated);
    return (
      <li key={key} className="flex items-start gap-2 py-1">
        {empty ? (
          <span className="mt-0.5 shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] text-green-800 dark:bg-green-900/30 dark:text-green-300">
            {t('guideAiWillFill')}
          </span>
        ) : (
          <label className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[11px] text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={overwrite[key] ?? false}
              onChange={(e) =>
                setOverwrite((prev) => ({ ...prev, [key]: e.target.checked }))
              }
            />
            {t('guideAiOverwrite')}
          </label>
        )}
        <span className="min-w-0 text-xs text-gray-700 dark:text-gray-300">
          <span className="font-medium">{t(`guideField_${key}`)}: </span>
          <span className="text-gray-500 dark:text-gray-400">{preview}</span>
        </span>
      </li>
    );
  };

  const AI_FIELD_ORDER: FieldKey[] = [
    'name',
    'description',
    'body',
    'voiceRules',
    'examples',
    'sections',
    'generalGuidance',
    'entries',
  ];

  return (
    <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <p className="text-sm font-semibold text-black dark:text-white">
          {existing
            ? t(isGlossary ? 'editGlossaryTitle' : 'editGuideTitle')
            : t(isGlossary ? 'newGlossaryTitle' : 'newGuideTitle')}
        </p>
        {!isGlossary && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${KIND_BADGE_CLASSES[kind]}`}
          >
            {t(`guideKind_${kind}`)}
          </span>
        )}
      </div>

      {payloadLoading && (
        <p
          className="mb-3 text-xs text-gray-500 dark:text-gray-400"
          role="status"
        >
          {payloadError ? (
            <>
              <span className="text-red-600 dark:text-red-400">
                {payloadError}
              </span>{' '}
              <button
                type="button"
                className="underline"
                onClick={retryPayloadLoad}
              >
                {t('retry')}
              </button>
            </>
          ) : (
            t('guidePayloadLoading')
          )}
        </p>
      )}

      <div className="space-y-4">
        <div className="flex gap-4">
          {!isGlossary && (
            <div className="flex-1">
              <label className={labelClass} htmlFor={`${baseId}-kind`}>
                {t('guideKindLabel')}
              </label>
              <select
                id={`${baseId}-kind`}
                className={inputClass}
                value={kind}
                onChange={(e) => changeKind(e.target.value as GuideKind)}
                // The payload shape, slot eligibility, and access key all
                // hang off the kind — locked after creation (server enforces
                // too).
                disabled={existing !== null}
              >
                {/* Glossaries have their own admin area; offering the kind
                    here would create a record that vanishes from this list. */}
                {GUIDE_KINDS.filter((k) => k !== 'terminology').map((k) => (
                  <option key={k} value={k}>
                    {t(`guideKind_${k}`)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {existing ? t('guideKindLocked') : t(`guideKindHint_${kind}`)}
              </p>
            </div>
          )}
          <div className="flex-1">
            <span className={labelClass}>{t('guideWorkflowsLabel')}</span>
            <div className="flex flex-col gap-1 pt-1">
              <label className="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={effectiveWorkflows.includes('document')}
                  disabled={documentOnly}
                  onChange={() => toggleWorkflow('document')}
                />
                {t('guideWorkflowDocument')}
              </label>
              <label className="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={effectiveWorkflows.includes('translation')}
                  disabled={documentOnly}
                  onChange={() => toggleWorkflow('translation')}
                />
                {t('guideWorkflowTranslation')}
              </label>
              {documentOnly && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('guideDocumentOnlyHint')}
                </p>
              )}
            </div>
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor={`${baseId}-name`}>
            {t('guideNameLabel')}
          </label>
          <input
            id={`${baseId}-name`}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('guideNamePlaceholder')}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor={`${baseId}-description`}>
            {t('guideDescriptionLabel')}
          </label>
          <input
            id={`${baseId}-description`}
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {kind === 'terminology' ? (
          <div>
            <span className={labelClass}>{t('glossaryLanguagePairLabel')}</span>
            <div className="flex flex-wrap gap-3">
              <div className="min-w-[14rem] flex-1">
                <label
                  className="mb-1 block text-[11px] text-gray-500 dark:text-gray-400"
                  htmlFor={`${baseId}-sourceLang`}
                >
                  {t('glossarySourceLangLabel')}
                </label>
                <select
                  id={`${baseId}-sourceLang`}
                  className={inputClass}
                  value={sourceLang}
                  onChange={(e) => setSourceLang(e.target.value)}
                >
                  <option value="">{t('glossaryAnyLanguage')}</option>
                  {languageOptions.map((lang) => (
                    <option key={lang.id} value={lang.id}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-[14rem] flex-1">
                <label
                  className="mb-1 block text-[11px] text-gray-500 dark:text-gray-400"
                  htmlFor={`${baseId}-targetLang`}
                >
                  {t('glossaryTargetLangLabel')}
                </label>
                <select
                  id={`${baseId}-targetLang`}
                  className={inputClass}
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                >
                  <option value="">{t('glossaryAnyLanguage')}</option>
                  {languageOptions.map((lang) => (
                    <option key={lang.id} value={lang.id}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {targetLang
                ? t('glossaryLanguagePairHint')
                : t('glossaryLanguagePairEncourage')}
            </p>
          </div>
        ) : (
          <div>
            <span className={labelClass}>{t('guideLanguagesLabel')}</span>
            <ChipListInput
              values={languages}
              onChange={setLanguages}
              placeholder={t('guideLanguagesPlaceholder')}
              addHint={t('guideLanguagesHint')}
              removeLabel={t('removeChip')}
            />
          </div>
        )}

        {/* ---- Kind-specific payload editor ---- */}

        {(kind === 'style' || kind === 'compliance') && (
          <div>
            <label className={labelClass} htmlFor={`${baseId}-body`}>
              {t('guideBodyLabel')}
            </label>
            <textarea
              id={`${baseId}-body`}
              className={`${inputClass} font-mono`}
              rows={14}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('guideBodyPlaceholder')}
              aria-invalid={bodyOverBy > 0}
              spellCheck={false}
            />
            <p
              className={`mt-1 text-xs ${
                bodyOverBy > 0
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              {bodyOverBy > 0
                ? t('guideBodyTooLong', { over: String(bodyOverBy) })
                : t('guideBodyCounter', {
                    length: String(body.length),
                    max: String(MAX_GUIDE_BODY_CHARS),
                  })}
            </p>
          </div>
        )}

        {kind === 'tone' && (
          <>
            <div>
              <label className={labelClass} htmlFor={`${baseId}-voiceRules`}>
                {t('guideVoiceRulesLabel')}
              </label>
              <textarea
                id={`${baseId}-voiceRules`}
                className={inputClass}
                rows={10}
                value={voiceRules}
                onChange={(e) => setVoiceRules(e.target.value)}
                placeholder={t('guideVoiceRulesPlaceholder')}
                aria-invalid={voiceRulesOverBy > 0}
              />
              {voiceRulesOverBy > 0 && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {t('guideBodyTooLong', { over: String(voiceRulesOverBy) })}
                </p>
              )}
            </div>
            <div>
              <label className={labelClass} htmlFor={`${baseId}-examples`}>
                {t('guideExamplesLabel')}
              </label>
              <textarea
                id={`${baseId}-examples`}
                className={inputClass}
                rows={5}
                value={examples}
                onChange={(e) => setExamples(e.target.value)}
                placeholder={t('guideExamplesPlaceholder')}
              />
            </div>
          </>
        )}

        {kind === 'structure' && (
          <div>
            <span className={labelClass}>{t('guideSectionsLabel')}</span>
            <SpecFieldsEditor
              value={{ sections, generalGuidance }}
              onChange={(next) => {
                setSections(next.sections);
                setGeneralGuidance(next.generalGuidance ?? '');
              }}
            />
            {sections.length > MAX_GUIDE_SECTIONS && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {t('guideTooManySections', {
                  max: String(MAX_GUIDE_SECTIONS),
                })}
              </p>
            )}
          </div>
        )}

        {kind === 'terminology' && (
          <div>
            <span className={labelClass}>{t('guideEntriesLabel')}</span>
            <GlossaryEntriesEditor
              value={entries}
              onChange={setEntries}
              disabled={payloadLoading}
              allowImport
            />
            {entries.length > MAX_GUIDE_ENTRIES && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {t('guideTooManyEntries', { max: String(MAX_GUIDE_ENTRIES) })}
              </p>
            )}
          </div>
        )}

        {/* ---- AI fill ---- */}

        <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <label
            className={`${labelClass} inline-flex items-center gap-1`}
            htmlFor={`${baseId}-aiPrompt`}
          >
            <IconSparkles size={13} aria-hidden />
            {t('guideAiLabel')}
          </label>
          <textarea
            id={`${baseId}-aiPrompt`}
            className={inputClass}
            rows={2}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder={t('guideAiPlaceholder')}
          />
          <button
            type="button"
            className="mt-2 rounded-md bg-gray-200 px-3 py-1 text-sm font-medium text-gray-900 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
            onClick={handleGenerate}
            disabled={!aiPrompt.trim() || isGenerating}
          >
            {isGenerating ? t('guideAiGenerating') : t('guideAiGenerate')}
          </button>
          {aiError && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {aiError}
            </p>
          )}

          {pendingFields && (
            <div className="mt-3 border-t border-gray-200 pt-2 dark:border-gray-700">
              <p className="mb-1 text-xs text-gray-600 dark:text-gray-400">
                {t('guideAiReviewHint')}
              </p>
              <ul>{AI_FIELD_ORDER.map(renderPendingField)}</ul>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
                  onClick={handleApplyGenerated}
                >
                  {t('guideAiApply')}
                </button>
                <button
                  type="button"
                  className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
                  onClick={() => setPendingFields(null)}
                >
                  {t('guideAiDiscard')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {saveError && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">
          {saveError}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={handleSave}
          disabled={!canSave || isSaving}
        >
          {t('save')}
        </button>
        <button
          type="button"
          className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
          onClick={onCancel}
          disabled={isSaving}
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  );
};

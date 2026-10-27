'use client';

import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { parseSkillBundle } from '@/lib/services/skills/skillBundle';
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from '@/lib/services/skills/skillMarkdown';
import {
  SKILL_LIMITS,
  UserSkill,
  UserSkillSchema,
  UserSkillsRequestSchema,
} from '@/lib/services/skills/types';
import { personalSkillFromBundle } from '@/lib/services/skills/userSkills';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CHECKBOX,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
} from '@/components/Admin/adminClasses';

import { useSettingsStore } from '@/client/stores/settingsStore';

const empty: UserSkill = {
  id: '',
  name: '',
  description: '',
  instructions: '',
  activation: 'auto',
  enabled: true,
};

/** Browser-local skill editor, with explicit import review and no organization write access. */
export function PersonalSkills() {
  const t = useTranslations('personalSkills');
  const fields = useTranslations('skillsAdmin');
  const skills = useSettingsStore((state) => state.userSkills);
  const setSkills = useSettingsStore((state) => state.setUserSkills);
  const [draft, setDraft] = useState<UserSkill | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importText, setImportText] = useState<string | null>(null);

  const review = (skill: UserSkill, skipped: string[] = []) => {
    setDraft(skill);
    setEditing(null);
    setImportText(null);
    setError('');
    setNotice(
      skipped.length ? `${t('skipped')}: ${skipped.join(', ')}` : t('review'),
    );
  };
  const parse = () => {
    const parsed = parseSkillMarkdown(importText ?? '');
    if (!parsed.ok) {
      setError(parsed.errors.join('\n'));
      return;
    }
    const { applyToAgents: _ignored, ...skill } = parsed.skill;
    review({ ...skill, enabled: true });
  };
  const importFile = async (file: File) => {
    try {
      if (file.size > SKILL_LIMITS.maxBundleBytes)
        throw new Error(t('importTooLarge'));
      if (/\.zip$/i.test(file.name)) {
        const bundle = parseSkillBundle(
          new Uint8Array(await file.arrayBuffer()),
        );
        review(personalSkillFromBundle(bundle), bundle.skipped);
      } else {
        const parsed = parseSkillMarkdown(await file.text());
        if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
        const { applyToAgents: _ignored, ...skill } = parsed.skill;
        review({ ...skill, enabled: true });
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : t('invalid'));
    }
  };
  const save = () => {
    const parsed = UserSkillSchema.safeParse(draft);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n'),
      );
      return;
    }
    if (!editing && skills.some((skill) => skill.id === parsed.data.id)) {
      setError(t('duplicate'));
      return;
    }
    const next = editing
      ? skills.map((skill) => (skill.id === editing ? parsed.data : skill))
      : [...skills, parsed.data];
    if (next.length > SKILL_LIMITS.maxUserSkills) {
      setError(t('countLimit'));
      return;
    }
    const request = UserSkillsRequestSchema.safeParse(
      next.filter((skill) => skill.enabled && skill.activation !== 'off'),
    );
    if (!request.success) {
      setError(t('requestLimit'));
      return;
    }
    setSkills(next);
    setDraft(null);
    setNotice(t('saved'));
    setError('');
  };
  const exportSkill = (skill: UserSkill) => {
    const content = serializeSkillMarkdown({ ...skill, applyToAgents: false });
    const url = URL.createObjectURL(
      new Blob([content], { type: 'text/markdown' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${skill.id}.SKILL.md`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section
      aria-label={t('title')}
      className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
    >
      <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">
        {t('title')}
      </h3>
      <p className="max-w-prose text-sm text-gray-600 dark:text-gray-300">
        {t('description')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          onClick={() => {
            setDraft({ ...empty });
            setEditing(null);
            setNotice('');
            setError('');
          }}
        >
          {fields('newSkill')}
        </button>
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={() => setImportText(importText === null ? '' : null)}
        >
          {fields('importSkill')}
        </button>
        <label className={ADMIN_LABEL}>
          {t('importFile')}
          <input
            type="file"
            accept=".md,.zip"
            className={`${ADMIN_FIELD} block`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className={`${ADMIN_BANNER_ERROR} whitespace-pre-wrap`}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-gray-700 dark:text-gray-300">
          {notice}
        </p>
      )}
      {importText !== null && (
        <div className="space-y-2">
          <label htmlFor="personal-skill-import" className={ADMIN_LABEL}>
            {fields('importTitle')}
          </label>
          <textarea
            id="personal-skill-import"
            className={`${ADMIN_FIELD} h-40 w-full font-mono`}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
          />
          <button type="button" className={ADMIN_BTN_SECONDARY} onClick={parse}>
            {fields('importParse')}
          </button>
        </div>
      )}
      {draft && (
        <div className="space-y-3 border-y border-gray-200 py-4 dark:border-gray-700">
          {(['id', 'name', 'description', 'instructions'] as const).map(
            (key) => (
              <div key={key}>
                <label
                  htmlFor={`personal-skill-${key}`}
                  className={ADMIN_LABEL}
                >
                  {fields(
                    key === 'id'
                      ? 'idLabel'
                      : key === 'name'
                        ? 'nameLabel'
                        : key === 'description'
                          ? 'descriptionLabel'
                          : 'instructionsLabel',
                  )}
                </label>
                {key === 'instructions' || key === 'description' ? (
                  <textarea
                    id={`personal-skill-${key}`}
                    className={`${ADMIN_FIELD} w-full ${key === 'instructions' ? 'h-64 font-mono' : 'h-20'}`}
                    value={draft[key]}
                    onChange={(event) =>
                      setDraft({ ...draft, [key]: event.target.value })
                    }
                  />
                ) : (
                  <input
                    id={`personal-skill-${key}`}
                    className={`${ADMIN_FIELD} w-full`}
                    disabled={key === 'id' && !!editing}
                    value={draft[key]}
                    onChange={(event) =>
                      setDraft({ ...draft, [key]: event.target.value })
                    }
                  />
                )}
              </div>
            ),
          )}
          <p className={ADMIN_HINT}>{t('instructionsHint')}</p>
          <label className={ADMIN_LABEL}>
            {fields('activationLabel')}
            <select
              className={`${ADMIN_FIELD} block`}
              value={draft.activation}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  activation: event.target.value as UserSkill['activation'],
                })
              }
            >
              {(['auto', 'always', 'off'] as const).map((value) => (
                <option key={value} value={value}>
                  {fields(`activation.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <p className={ADMIN_HINT}>
            {fields(`activationHint.${draft.activation}`)}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className={ADMIN_CHECKBOX}
              checked={draft.enabled}
              onChange={(event) =>
                setDraft({ ...draft, enabled: event.target.checked })
              }
            />
            {t('enabled')}
          </label>
          <div className="flex gap-2">
            <button type="button" className={ADMIN_BTN_PRIMARY} onClick={save}>
              {fields('save')}
            </button>
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={() => {
                setDraft(null);
                setError('');
              }}
            >
              {fields('cancel')}
            </button>
          </div>
        </div>
      )}
      <ul className="divide-y divide-gray-200 dark:divide-gray-700">
        {skills.map((skill) => (
          <li
            key={skill.id}
            className="flex flex-wrap items-center justify-between gap-2 py-3"
          >
            <div className="min-w-0">
              <p className="break-words font-medium">
                {skill.name}{' '}
                <span className="text-xs text-gray-600 dark:text-gray-300">
                  user:{skill.id}
                </span>
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-300">
                {skill.enabled
                  ? fields(`activation.${skill.activation}`)
                  : fields('activation.off')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                onClick={() => {
                  setDraft({ ...skill });
                  setEditing(skill.id);
                  setNotice('');
                  setError('');
                }}
              >
                {fields('edit')}
              </button>
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                onClick={() => exportSkill(skill)}
              >
                {fields('exportSkill')}
              </button>
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                onClick={() => {
                  if (window.confirm(fields('deleteConfirm'))) {
                    setSkills(skills.filter((entry) => entry.id !== skill.id));
                    if (editing === skill.id) setDraft(null);
                  }
                }}
              >
                {fields('delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!skills.length && (
        <p className="text-sm text-gray-600 dark:text-gray-300">{t('empty')}</p>
      )}
    </section>
  );
}

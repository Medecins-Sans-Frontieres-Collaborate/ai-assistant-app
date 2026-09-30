'use client';

import { IconRestore } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { AvailableGuide } from '@/client/hooks/settings/useAvailableGuides';

import { ChannelProfile, ChannelRule, ChannelSetData } from '@/types/drafter';

export const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-black focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white';
export const buttonClass =
  'shrink-0 rounded-md border border-gray-200 px-3 py-1 text-sm text-black hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-white dark:hover:bg-gray-800';
const labelClass = 'block text-xs text-gray-700 dark:text-gray-300';
const hintClass = 'mt-1 block text-xs text-gray-500 dark:text-gray-400';

/** Guides Check applies by default: what the drafter workspace offers. */
export function isCheckGuide(guide: AvailableGuide): boolean {
  return guide.kind === 'style' || guide.kind === 'compliance';
}

interface ChannelSetEditorProps {
  /** Null while creating: the id is minted by the server. */
  setId: string | null;
  value: ChannelSetData;
  onChange: (next: ChannelSetData) => void;
  platforms: ChannelProfile[];
  guides: AvailableGuide[];
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * The form for one channel rule set: identity, one row per platform with
 * the team's rules over it, and the defaults a new draft starts with. Pure
 * over `value`/`onChange`; the section owns saving. An empty rule field
 * means "the platform's own", so every such input shows the platform's
 * value as its placeholder rather than copying it in.
 */
export function ChannelSetEditor({
  setId,
  value,
  onChange,
  platforms,
  guides,
  busy,
  error,
  onSave,
  onCancel,
}: ChannelSetEditorProps) {
  const t = useTranslations('adminChannelSets');
  const ta = useTranslations('agentAccess');
  const tp = useTranslations('adminChannelProfiles');

  const toneGuides = guides.filter((guide) => guide.kind === 'tone');
  const checkGuides = guides.filter(isCheckGuide);
  const enabledPlatforms = platforms.filter(
    (platform) => value.channels[platform.id]?.enabled,
  );

  const setRule = (id: string, rule: ChannelRule) => {
    onChange({ ...value, channels: { ...value.channels, [id]: rule } });
  };

  const patchRule = (id: string, patch: Partial<ChannelRule>) => {
    const rule: ChannelRule = { ...(value.channels[id] ?? { enabled: true }) };
    for (const [key, next] of Object.entries(patch)) {
      // An undefined patch value clears the override rather than storing it.
      if (next === undefined) {
        delete rule[key as keyof ChannelRule];
      } else {
        Object.assign(rule, { [key]: next });
      }
    }
    setRule(id, rule);
  };

  const toggleChannel = (id: string, enabled: boolean) => {
    const rule: ChannelRule = { ...(value.channels[id] ?? {}), enabled };
    onChange({
      ...value,
      channels: { ...value.channels, [id]: rule },
      defaults: {
        ...value.defaults,
        // A default channel must be one the set offers.
        channelIds: enabled
          ? value.defaults.channelIds
          : value.defaults.channelIds.filter((entry) => entry !== id),
      },
    });
  };

  const toggleDefaultChannel = (id: string, on: boolean) => {
    const selected = new Set(value.defaults.channelIds);
    if (on) selected.add(id);
    else selected.delete(id);
    onChange({
      ...value,
      defaults: {
        ...value.defaults,
        // Platform order, so the draft's columns match the admin's list.
        channelIds: platforms
          .filter((platform) => selected.has(platform.id))
          .map((platform) => platform.id),
      },
    });
  };

  const toggleGuide = (id: string, on: boolean) => {
    const next = on
      ? [...value.defaults.guideIds, id]
      : value.defaults.guideIds.filter((entry) => entry !== id);
    onChange({ ...value, defaults: { ...value.defaults, guideIds: next } });
  };

  const placementLabel = (placement: 'inline' | 'end' | 'none') =>
    t(`placement.${placement}`);
  const linkLabel = (position: 'first' | 'last') =>
    position === 'first' ? tp('linksFirst') : tp('linksLast');

  const channelRow = (platform: ChannelProfile) => {
    const rule = value.channels[platform.id];
    const enabled = !!rule?.enabled;
    const hasVoice =
      !!rule?.defaultVoiceGuideId &&
      !toneGuides.some((guide) => guide.id === rule.defaultVoiceGuideId);
    return (
      <li
        key={platform.id}
        className="rounded-md border border-gray-200 p-2 dark:border-gray-700"
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            aria-label={t('enableChannel', { name: platform.name })}
            title={t('enableChannel', { name: platform.name })}
            onChange={(e) => toggleChannel(platform.id, e.target.checked)}
          />
          <span className="text-sm font-medium text-black dark:text-white">
            {platform.name}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {tp('summary', {
              limit: platform.segmentLimit,
              posts: platform.maxSegments,
            })}
          </span>
        </div>
        {enabled && rule && (
          <div className="mt-2 space-y-2">
            <label className={labelClass}>
              <span className="flex items-center justify-between gap-2">
                <span title={t('guidanceHint')}>{t('guidance')}</span>
                {rule.guidance !== undefined && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline dark:text-blue-400"
                    title={t('resetToPlatform')}
                    onClick={() =>
                      patchRule(platform.id, { guidance: undefined })
                    }
                  >
                    <IconRestore size={14} aria-hidden />
                    {t('resetToPlatform')}
                  </button>
                )}
              </span>
              <textarea
                className={`${inputClass} mt-1`}
                rows={3}
                maxLength={2000}
                value={rule.guidance ?? ''}
                placeholder={platform.guidance}
                onChange={(e) =>
                  patchRule(platform.id, {
                    guidance:
                      e.target.value === '' ? undefined : e.target.value,
                  })
                }
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <label className={labelClass}>
                {t('hashtagsMax')}
                <input
                  type="number"
                  min={0}
                  max={30}
                  className={`${inputClass} mt-1`}
                  value={rule.hashtags?.max ?? ''}
                  placeholder={String(platform.hashtags.max)}
                  title={t('platformValueHint')}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === '') {
                      patchRule(platform.id, { hashtags: undefined });
                      return;
                    }
                    const parsed = Number.parseInt(raw, 10);
                    if (!Number.isFinite(parsed)) return;
                    // The input's min/max only guide typing; the value sent
                    // is what the server accepts.
                    const max = Math.min(30, Math.max(0, parsed));
                    const placement =
                      rule.hashtags?.placement ??
                      (platform.hashtags.placement === 'none'
                        ? 'end'
                        : platform.hashtags.placement);
                    patchRule(platform.id, {
                      hashtags: {
                        max,
                        placement: max === 0 ? 'none' : placement,
                      },
                    });
                  }}
                />
              </label>
              <label className={labelClass}>
                {t('hashtagsPlacement')}
                <select
                  className={`${inputClass} mt-1`}
                  disabled={!rule.hashtags}
                  value={
                    rule.hashtags?.placement ?? platform.hashtags.placement
                  }
                  onChange={(e) =>
                    rule.hashtags &&
                    patchRule(platform.id, {
                      hashtags: {
                        ...rule.hashtags,
                        placement: e.target.value as 'inline' | 'end' | 'none',
                      },
                    })
                  }
                >
                  {(['inline', 'end', 'none'] as const).map((placement) => (
                    <option key={placement} value={placement}>
                      {placementLabel(placement)}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className={labelClass}
                title={
                  platform.links.allowed ? undefined : t('linksNotAllowed')
                }
              >
                {t('linkPosition')}
                <select
                  className={`${inputClass} mt-1`}
                  disabled={!platform.links.allowed}
                  value={rule.linkPosition ?? ''}
                  onChange={(e) =>
                    patchRule(platform.id, {
                      linkPosition:
                        e.target.value === ''
                          ? undefined
                          : (e.target.value as 'first' | 'last'),
                    })
                  }
                >
                  <option value="">
                    {t('platformValue', {
                      value: linkLabel(platform.links.position),
                    })}
                  </option>
                  <option value="last">{tp('linksLast')}</option>
                  <option value="first">{tp('linksFirst')}</option>
                </select>
              </label>
              <label className={labelClass} title={t('voiceHint')}>
                {t('voice')}
                <select
                  className={`${inputClass} mt-1`}
                  value={rule.defaultVoiceGuideId ?? ''}
                  onChange={(e) =>
                    patchRule(platform.id, {
                      defaultVoiceGuideId:
                        e.target.value === '' ? undefined : e.target.value,
                    })
                  }
                >
                  <option value="">{t('noVoice')}</option>
                  {toneGuides.map((guide) => (
                    <option key={guide.id} value={guide.id}>
                      {guide.name}
                    </option>
                  ))}
                  {hasVoice && rule.defaultVoiceGuideId && (
                    <option value={rule.defaultVoiceGuideId}>
                      {t('unavailableGuide', { id: rule.defaultVoiceGuideId })}
                    </option>
                  )}
                </select>
              </label>
              <label className={labelClass} title={tp('publishTargetHint')}>
                {t('hootsuite')}
                <input
                  className={`${inputClass} mt-1`}
                  maxLength={200}
                  value={rule.publishTarget ?? ''}
                  onChange={(e) =>
                    patchRule(platform.id, {
                      publishTarget: e.target.value.trim()
                        ? e.target.value
                        : undefined,
                    })
                  }
                />
              </label>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="mt-3 space-y-4 rounded-md bg-gray-50 p-3 dark:bg-gray-800/50">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          {t('name')}
          <input
            className={`${inputClass} mt-1`}
            value={value.name}
            maxLength={60}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </label>
        <label className={labelClass} title={t('languageHint')}>
          {t('language')}
          <input
            className={`${inputClass} mt-1`}
            value={value.language}
            maxLength={40}
            placeholder={t('languagePlaceholder')}
            onChange={(e) => onChange({ ...value, language: e.target.value })}
          />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>
          {t('description')}
          <input
            className={`${inputClass} mt-1`}
            value={value.description}
            maxLength={300}
            onChange={(e) =>
              onChange({ ...value, description: e.target.value })
            }
          />
        </label>
        {/* The server ignores `isDefault` on create (a new set starts
            restricted to its author), so the tick is only offered once the
            set exists rather than being silently dropped. */}
        {setId ? (
          <label
            className="flex items-center gap-2 text-sm text-black dark:text-white"
            title={t('isDefaultHint')}
          >
            <input
              type="checkbox"
              checked={value.isDefault}
              onChange={(e) =>
                onChange({ ...value, isDefault: e.target.checked })
              }
            />
            {t('isDefault')}
          </label>
        ) : (
          <span className="self-center text-xs text-gray-500 dark:text-gray-400">
            {t('isDefaultAfterSave')}
          </span>
        )}
      </div>

      <section aria-label={t('channels')}>
        <h3 className="text-sm font-medium text-black dark:text-white">
          {t('channels')}
        </h3>
        <p className={hintClass}>{t('channelsHint')}</p>
        {enabledPlatforms.length === 0 && (
          <p
            role="status"
            className="mt-1 text-xs text-amber-800 dark:text-amber-300"
          >
            {t('noChannelsWarning')}
          </p>
        )}
        <ul className="mt-2 space-y-2">{platforms.map(channelRow)}</ul>
      </section>

      <section aria-label={t('defaults')} className="space-y-3">
        <h3 className="text-sm font-medium text-black dark:text-white">
          {t('defaults')}
        </h3>
        <div title={t('startsWithHint')}>
          <span className={labelClass}>{t('startsWith')}</span>
          <div className="mt-1 flex flex-wrap gap-3">
            {enabledPlatforms.length === 0 && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('noChannelsEnabled')}
              </span>
            )}
            {enabledPlatforms.map((platform) => (
              <label
                key={platform.id}
                className="flex items-center gap-1 text-sm text-black dark:text-white"
              >
                <input
                  type="checkbox"
                  checked={value.defaults.channelIds.includes(platform.id)}
                  onChange={(e) =>
                    toggleDefaultChannel(platform.id, e.target.checked)
                  }
                />
                {platform.name}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass} title={t('donationUrlHint')}>
            {t('donationUrl')}
            <input
              type="url"
              className={`${inputClass} mt-1`}
              maxLength={500}
              value={value.defaults.donationUrl ?? ''}
              placeholder="https://"
              onChange={(e) =>
                onChange({
                  ...value,
                  defaults: {
                    ...value.defaults,
                    donationUrl: e.target.value.trim()
                      ? e.target.value
                      : undefined,
                  },
                })
              }
            />
          </label>
          <label
            className="flex items-center gap-2 self-end text-sm text-black dark:text-white"
            title={t('articleLinkHint')}
          >
            <input
              type="checkbox"
              checked={value.defaults.articleLink}
              onChange={(e) =>
                onChange({
                  ...value,
                  defaults: {
                    ...value.defaults,
                    articleLink: e.target.checked,
                  },
                })
              }
            />
            {t('articleLink')}
          </label>
        </div>
        <div title={t('checkGuidesHint')}>
          <span className={labelClass}>{t('checkGuides')}</span>
          <div className="mt-1 flex flex-wrap gap-3">
            {checkGuides.length === 0 && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('noCheckGuides')}
              </span>
            )}
            {checkGuides.map((guide) => {
              const checked = value.defaults.guideIds.includes(guide.id);
              return (
                <label
                  key={guide.id}
                  className="flex items-center gap-1 text-sm text-black dark:text-white"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && value.defaults.guideIds.length >= 3}
                    onChange={(e) => toggleGuide(guide.id, e.target.checked)}
                  />
                  {guide.name}
                </label>
              );
            })}
          </div>
        </div>
      </section>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={busy || !value.name.trim()}
          onClick={onSave}
        >
          {ta('save')}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={onCancel}
        >
          {ta('cancel')}
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {setId
            ? t('editorsNote', { key: `channel-set::${setId}` })
            : t('newSetNote')}
        </span>
      </div>
    </div>
  );
}

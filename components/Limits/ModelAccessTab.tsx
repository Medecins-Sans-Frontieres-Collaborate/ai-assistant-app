'use client';

import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { FC, ReactNode, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import type {
  LimitEntry,
  LimitsMode,
  ModelAccessRule,
} from '@/lib/services/limits/types';

import {
  EffectiveAccess,
  ModelAccessDimension,
  ModelAccessFamilyNode,
  ModelAccessModelNode,
  buildModelAccessTree,
  catalogModelsForAdmin,
  collidesWithDefaults,
  effectiveAccessFor,
  externalFamilyLabels,
  ruleFor,
  upsertRule,
} from '@/lib/utils/app/modelAccessTree';

import {
  ADMIN_BANNER_WARN,
  ADMIN_CARD,
  ADMIN_CHIP_DANGER,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_CHIP_WARN,
  ADMIN_HEADING,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import {
  ModelAccessNodeEditor,
  stateLabel,
} from '@/components/Limits/ModelAccessNodeEditor';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface ModelAccessTabProps {
  rules: ModelAccessRule[];
  /** The draft's global defaults — inheritance reads them, collisions warn. */
  defaults: LimitEntry[];
  onChange: (rules: ModelAccessRule[]) => void;
  mode: LimitsMode;
  disabled?: boolean;
}

/**
 * The model approval view (docs/LIMITS.md "Model approval"): families, each
 * with its models, and per node a default for everyone plus groups, domains,
 * an allow list and a block list. A model inherits its family's default
 * unless it sets its own; the inherited answer is resolved with the real
 * resolver over the draft, so the line under the control is what the send
 * will do.
 */
export const ModelAccessTab: FC<ModelAccessTabProps> = ({
  rules,
  defaults,
  onChange,
  mode,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const liveModels = useSettingsStore((s) => s.models);
  const tree = useMemo(
    () => buildModelAccessTree(catalogModelsForAdmin(liveModels), rules),
    [liveModels, rules],
  );
  const external = externalFamilyLabels(tree);

  const setRule = (dim: ModelAccessDimension, next: ModelAccessRule) =>
    onChange(upsertRule(rules, dim, next));

  const renderModel = (model: ModelAccessModelNode, nested: boolean) => {
    const dim = { modelId: model.modelId };
    return (
      <Node
        key={model.modelId}
        dimension={dim}
        label={model.label}
        kindChip={t('modelAccess.modelChip')}
        known={model.known}
        rule={ruleFor(rules, dim)}
        effective={effectiveAccessFor(dim, model.series, defaults, rules)}
        collision={collidesWithDefaults(dim, ruleFor(rules, dim), defaults)}
        onChange={(next) => setRule(dim, next)}
        disabled={disabled}
        nested={nested}
      />
    );
  };

  const renderFamily = (family: ModelAccessFamilyNode) => {
    const dim = { series: family.series };
    return (
      <Node
        key={family.series}
        dimension={dim}
        label={family.label}
        kindChip={t('modelAccess.familyChip')}
        known={family.known}
        rule={ruleFor(rules, dim)}
        effective={effectiveAccessFor(dim, undefined, defaults, rules)}
        collision={collidesWithDefaults(dim, ruleFor(rules, dim), defaults)}
        onChange={(next) => setRule(dim, next)}
        disabled={disabled}
        defaultExpanded
        childrenLabel={t('modelAccess.modelsInFamily', {
          count: family.models.length,
        })}
      >
        {family.models.map((model) => renderModel(model, true))}
      </Node>
    );
  };

  return (
    <div className="space-y-4">
      <p className={ADMIN_MUTED}>{t('modelAccess.intro')}</p>
      {external.length > 0 && (
        <p className={ADMIN_MUTED}>
          {t('modelAccess.externalNote', { families: external.join(', ') })}
        </p>
      )}
      <p className={ADMIN_MUTED}>{t('modelAccess.envelopeNote')}</p>
      {mode === 'observe' && (
        <p className={ADMIN_BANNER_WARN} role="note">
          {t('modelAccess.observeNote')}
        </p>
      )}

      {tree.families.length === 0 && tree.orphans.length === 0 && (
        <p className={ADMIN_MUTED}>{t('modelAccess.noModels')}</p>
      )}

      <div className="space-y-3">{tree.families.map(renderFamily)}</div>

      {tree.orphans.length > 0 && (
        <section aria-labelledby="model-access-orphans">
          <h3 id="model-access-orphans" className={`mb-2 ${ADMIN_HEADING}`}>
            {t('modelAccess.otherModels')}
          </h3>
          <div className="space-y-3">
            {tree.orphans.map((model) => renderModel(model, false))}
          </div>
        </section>
      )}
    </div>
  );
};

interface NodeProps {
  dimension: ModelAccessDimension;
  label: string;
  kindChip: string;
  known: boolean;
  rule: ModelAccessRule | undefined;
  effective: EffectiveAccess;
  collision: boolean;
  onChange: (next: ModelAccessRule) => void;
  disabled: boolean;
  nested?: boolean;
  defaultExpanded?: boolean;
  childrenLabel?: string;
  children?: ReactNode;
}

/** One collapsible node: header with its state and list counts; body = editor (+ members). */
const Node: FC<NodeProps> = ({
  dimension,
  label,
  kindChip,
  known,
  rule,
  effective,
  collision,
  onChange,
  disabled,
  nested = false,
  defaultExpanded = false,
  childrenLabel,
  children,
}) => {
  const t = useTranslations('limits');
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  const counts = [
    rule?.groups.length
      ? t('modelAccess.groupsCount', { count: rule.groups.length })
      : null,
    rule?.domains.length
      ? t('modelAccess.domainsCount', { count: rule.domains.length })
      : null,
    rule?.allow.length
      ? t('modelAccess.allowCount', { count: rule.allow.length })
      : null,
    rule?.deny.length
      ? t('modelAccess.denyCount', { count: rule.deny.length })
      : null,
  ].filter((part): part is string => part !== null);
  const inherited = rule?.defaultAccess === undefined;
  const stateChip =
    effective.state.kind === 'unavailable'
      ? ADMIN_CHIP_DANGER
      : ADMIN_CHIP_NEUTRAL;
  const hasChildren = children !== undefined;

  return (
    <div className={nested ? `${ADMIN_CARD} ml-4` : ADMIN_CARD}>
      <div className="flex flex-wrap items-center gap-2">
        {hasChildren && (
          <button
            type="button"
            className="flex items-center rounded text-gray-500 hover:text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-white"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={
              expanded ? t('modelAccess.collapse') : t('modelAccess.expand')
            }
          >
            {expanded ? (
              <IconChevronDown size={16} aria-hidden="true" />
            ) : (
              <IconChevronRight size={16} aria-hidden="true" />
            )}
          </button>
        )}
        <span className="text-sm font-medium text-black dark:text-white">
          {label}
        </span>
        <span className={ADMIN_CHIP_NEUTRAL}>{kindChip}</span>
        {!known && (
          <span className={ADMIN_MUTED} title={t('unknownQualifierHint')}>
            {t('unknownQualifier')}
          </span>
        )}
        <span className={stateChip} data-testid="model-access-state">
          {stateLabel(t, effective.state)}
          {inherited ? ` · ${t('modelAccess.inheritedChip')}` : ''}
        </span>
        {collision && (
          <span className={ADMIN_CHIP_WARN}>
            {t('modelAccess.collisionChip')}
          </span>
        )}
        {counts.length > 0 && (
          <span className={ADMIN_MUTED}>{counts.join(' · ')}</span>
        )}
        <button
          type="button"
          className="ml-auto rounded text-xs text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
          onClick={() => setEditing((v) => !v)}
          aria-expanded={editing}
          aria-label={t('modelAccess.editNode', { label })}
        >
          {editing ? t('modelAccess.doneEditing') : t('modelAccess.edit')}
        </button>
      </div>

      {editing && (
        <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
          <ModelAccessNodeEditor
            dimension={dimension}
            rule={rule}
            effective={effective}
            onChange={onChange}
            collision={collision}
            disabled={disabled}
          />
        </div>
      )}

      {hasChildren && expanded && (
        <div className="mt-3 space-y-2">
          {childrenLabel && <div className={ADMIN_MUTED}>{childrenLabel}</div>}
          {children}
        </div>
      )}
    </div>
  );
};

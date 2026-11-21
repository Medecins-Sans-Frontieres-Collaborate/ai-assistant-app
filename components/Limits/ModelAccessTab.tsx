'use client';

import { IconPlus, IconTrash } from '@tabler/icons-react';
import { FC, Fragment, ReactNode, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useGroupNames } from '@/client/hooks/useGroupNames';

import type {
  LimitEntry,
  LimitValue,
  LimitsMode,
  ModelAccessRule,
} from '@/lib/services/limits/types';

import {
  Audience,
  AudienceColumn,
  AudienceCounts,
  AudienceEntry,
  AudienceTerms,
  GridCell,
  Reach,
  audienceCell,
  audienceColumns,
  audienceEntries,
  audienceId,
  columnId,
  peopleCounts,
  reachOf,
  withAudienceTerms,
  withAudiencesTerms,
  withDefaultAccess,
} from '@/lib/utils/app/modelAccessGrid';
import {
  AccessState,
  ModelAccessDimension,
  ModelAccessModelNode,
  buildModelAccessTree,
  catalogModelsForAdmin,
  collidesWithDefaults,
  effectiveAccessFor,
  externalFamilyLabels,
  ruleFor,
} from '@/lib/utils/app/modelAccessTree';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_WARN,
  ADMIN_HINT,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { AudiencePicker } from '@/components/Limits/AudiencePicker';
import { ValueChoice, ValueKind } from '@/components/Limits/ValueChoice';
import { AudienceShape, ValueChip } from '@/components/Limits/visualSyntax';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { getLimitDefinition } from '@/config/limits';

interface ModelAccessTabProps {
  rules: ModelAccessRule[];
  /** The draft's global defaults: inheritance reads them, collisions warn. */
  defaults: LimitEntry[];
  onChange: (rules: ModelAccessRule[]) => void;
  mode: LimitsMode;
  disabled?: boolean;
}

/** One row of the grid: a family, or a model (with its family's series). */
interface GridRow {
  key: string;
  dimension: ModelAccessDimension;
  series: string | undefined;
  label: string;
  known: boolean;
  isFamily: boolean;
}

/** The column a row was opened from: a fixed one, or an audience column id. */
type ColumnKey = 'everyone' | 'people' | string;

/** What a named audience can be given: a cap, no cap, or no access. */
const TERMS_KINDS: readonly ValueKind[] = ['limit', 'unlimited', 'off'];

/** Terms as the value the shared chips and control understand (0 = off). */
function valueOfTerms(terms: AudienceTerms): LimitValue {
  return terms === false ? 0 : terms;
}

/** The terms a value from the shared control stands for. */
function termsOfValue(value: LimitValue | undefined): AudienceTerms {
  if (value === null || value === true || value === undefined) return null;
  return value === false || value === 0 ? false : value;
}

/** A state as the value the shared chips and control understand (0 = off). */
function valueOfState(state: AccessState): LimitValue {
  if (state.kind === 'unavailable') return 0;
  return state.kind === 'unlimited' ? null : state.requests;
}

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** A state in words: "Unlimited", "Limited to 50 / day", "Unavailable". */
function stateLabel(t: Translate, state: AccessState): string {
  if (state.kind === 'limited') {
    return t('modelAccess.state.limited', { requests: state.requests });
  }
  return t(`modelAccess.state.${state.kind}`);
}

/** Terms in the same words as {@link stateLabel}. */
function termsLabel(t: Translate, terms: AudienceTerms): string {
  if (terms === false) return t('modelAccess.state.unavailable');
  if (terms === null) return t('modelAccess.state.unlimited');
  return t('modelAccess.state.limited', { requests: terms });
}

function modelRow(model: ModelAccessModelNode): GridRow {
  return {
    key: `model:${model.modelId}`,
    dimension: { modelId: model.modelId },
    series: model.series,
    label: model.label,
    known: model.known,
    isFamily: false,
  };
}

/**
 * Model access as ONE GRID (docs/LIMITS.md "Model approval"): a row per
 * family and model, a column per audience. Reading across a row says who
 * can use that model and on what terms; reading down a column says what one
 * audience gets. A model with nothing of its own in a column shows what its
 * family sets there, dashed.
 *
 * EDITING is the same for every kind of audience. Selecting a row opens one
 * editor: the answer for everyone else, then a single list of the groups,
 * domains and people named on the row, each with the same Limit / Unlimited
 * / Off control, and one field that adds any mix of the three at once. The
 * same field, with a list of rows, gives one audience the same terms on
 * several models in one step.
 *
 * The "everyone else" answer is resolved with the real resolver over the
 * draft, so what a cell says is what a send will do.
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
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selected, setSelected] = useState<{
    row: string;
    column: ColumnKey;
  } | null>(null);
  const columns = useMemo(() => audienceColumns(rules), [rules]);
  const groupNames = useGroupNames(
    rules.flatMap((rule) => [
      ...rule.groups.map((grant) => grant.target),
      ...(rule.denyGroups ?? []),
    ]),
  );
  const audienceName = (audience: Audience): string =>
    audience.scope === 'group'
      ? (groupNames[audience.target] ?? audience.target)
      : audience.target;

  const sections: Array<{ key: string; heading?: string; rows: GridRow[] }> = [
    ...tree.families.map((family) => ({
      key: `family:${family.series}`,
      rows: [
        {
          key: `family:${family.series}`,
          dimension: { series: family.series },
          series: undefined,
          label: family.label,
          known: family.known,
          isFamily: true,
        },
        ...family.models.map(modelRow),
      ],
    })),
    ...(tree.orphans.length > 0
      ? [
          {
            key: 'orphans',
            heading: t('modelAccess.otherModels'),
            rows: tree.orphans.map(modelRow),
          },
        ]
      : []),
  ];
  const columnCount = columns.length + 4;

  const select = (row: string, column: ColumnKey) =>
    setSelected((current) =>
      current?.row === row && current.column === column
        ? null
        : { row, column },
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-[1_1_28rem] space-y-1">
          <p className={ADMIN_MUTED}>{t('modelAccess.grid.lead')}</p>
          {external.length > 0 && (
            <p className={ADMIN_MUTED}>
              {t('modelAccess.externalNote', { families: external.join(', ') })}
            </p>
          )}
        </div>
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={() => setBulkOpen((value) => !value)}
          aria-expanded={bulkOpen}
          disabled={disabled || sections.length === 0}
        >
          <IconPlus size={16} aria-hidden="true" />
          {t('modelAccess.grid.bulk.open')}
        </button>
      </div>
      {bulkOpen && (
        <BulkAccessForm
          sections={sections}
          disabled={disabled}
          onApply={(dims, audiences, terms) => {
            onChange(withAudiencesTerms(rules, dims, audiences, terms));
            setBulkOpen(false);
          }}
          onCancel={() => setBulkOpen(false)}
        />
      )}
      {mode === 'observe' && (
        <p className={ADMIN_BANNER_WARN} role="note">
          {t('modelAccess.observeNote')}
        </p>
      )}

      {sections.length === 0 ? (
        <p className={ADMIN_MUTED}>{t('modelAccess.noModels')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-surface-dark">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              {t('modelAccess.grid.caption')}
            </caption>
            <thead>
              <tr className="text-left text-xs text-gray-600 dark:text-gray-400">
                <th
                  scope="col"
                  className="min-w-[13rem] px-4 py-2 font-semibold"
                >
                  {t('modelAccess.grid.col.model')}
                </th>
                <ColumnHeading kind="everyone">
                  {t('modelAccess.defaultLabel')}
                </ColumnHeading>
                {columns.map((column) => (
                  <ColumnHeading key={columnId(column)} kind={column.scope}>
                    {audienceName(column)}
                  </ColumnHeading>
                ))}
                <ColumnHeading kind="user">
                  {t('modelAccess.grid.col.people')}
                </ColumnHeading>
                <th
                  scope="col"
                  className="min-w-[9rem] px-2 py-2 font-semibold"
                >
                  {t('modelAccess.grid.col.reach')}
                </th>
              </tr>
            </thead>
            {sections.map((section) => (
              <tbody
                key={section.key}
                className="border-t border-gray-200 dark:border-gray-700"
              >
                {section.heading && (
                  <tr>
                    <th
                      scope="rowgroup"
                      colSpan={columnCount}
                      className="px-4 pt-3 text-left text-xs font-semibold text-gray-600 dark:text-gray-400"
                    >
                      {section.heading}
                    </th>
                  </tr>
                )}
                {section.rows.map((row) => (
                  <Row
                    key={row.key}
                    row={row}
                    rules={rules}
                    defaults={defaults}
                    columns={columns}
                    audienceName={audienceName}
                    columnCount={columnCount}
                    selected={
                      selected?.row === row.key ? selected.column : null
                    }
                    onSelect={(column) => select(row.key, column)}
                    onClose={() => setSelected(null)}
                    onChange={onChange}
                    disabled={disabled}
                  />
                ))}
              </tbody>
            ))}
          </table>
          <p className="border-t border-gray-200 px-4 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400">
            {t('modelAccess.envelopeNote')}
          </p>
        </div>
      )}

      <section
        aria-labelledby="model-access-how"
        className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-800 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-200"
      >
        <h3
          id="model-access-how"
          className="mb-2 text-sm font-semibold text-gray-900 dark:text-white"
        >
          {t('modelAccess.grid.howTitle')}
        </h3>
        <ol className="list-decimal space-y-1 ps-5">
          <li>{t('modelAccess.grid.how.blocked')}</li>
          <li>{t('modelAccess.grid.how.mostSpecific')}</li>
          <li>{t('modelAccess.grid.how.inherit')}</li>
          <li>{t('modelAccess.grid.how.envelope')}</li>
        </ol>
      </section>
    </div>
  );
};

const ColumnHeading: FC<{
  kind: 'everyone' | 'group' | 'domain' | 'user';
  children: ReactNode;
}> = ({ kind, children }) => (
  <th scope="col" className="min-w-[9rem] px-2 py-2 font-semibold">
    <span className="inline-flex items-center gap-1 [overflow-wrap:anywhere]">
      <AudienceShape kind={kind} />
      {children}
    </span>
  </th>
);

/**
 * WHO and WHAT THEY GET, as one unit: the mixed people / groups / domains
 * field beside the terms control. Shared by the row editor (add to this
 * row) and the several-models form, so adding reads the same in both.
 */
const AudienceTermsFields: FC<{
  audiences: Audience[];
  onAudiencesChange: (audiences: Audience[]) => void;
  terms: AudienceTerms;
  onTermsChange: (terms: AudienceTerms) => void;
  disabled: boolean;
}> = ({ audiences, onAudiencesChange, terms, onTermsChange, disabled }) => {
  const t = useTranslations('limits');
  const requestsDef = getLimitDefinition('model.requests');
  if (!requestsDef) return null;
  return (
    <div className="grid gap-x-4 gap-y-3 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <div className="mb-1 text-xs font-semibold text-gray-900 dark:text-white">
          {t('modelAccess.audience.who')}
        </div>
        <AudiencePicker
          value={audiences}
          onChange={onAudiencesChange}
          label={t('modelAccess.audience.pickerLabel')}
          disabled={disabled}
        />
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold text-gray-900 dark:text-white">
          {t('modelAccess.audience.terms')}
        </div>
        <ValueChoice
          def={requestsDef}
          kinds={TERMS_KINDS}
          label={t('modelAccess.audience.newTerms')}
          value={valueOfTerms(terms)}
          inherited={null}
          onChange={(value) => onTermsChange(termsOfValue(value))}
          disabled={disabled}
        />
      </div>
    </div>
  );
};

/** The same audiences and terms on several rows, applied in one step. */
const BulkAccessForm: FC<{
  sections: Array<{ key: string; heading?: string; rows: GridRow[] }>;
  disabled: boolean;
  onApply: (
    dims: ModelAccessDimension[],
    audiences: Audience[],
    terms: AudienceTerms,
  ) => void;
  onCancel: () => void;
}> = ({ sections, disabled, onApply, onCancel }) => {
  const t = useTranslations('limits');
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [terms, setTerms] = useState<AudienceTerms>(null);
  const [rowKeys, setRowKeys] = useState<Set<string>>(new Set());
  const rows = sections.flatMap((section) => section.rows);
  const chosen = rows.filter((row) => rowKeys.has(row.key));
  const toggle = (key: string) =>
    setRowKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <section
      aria-labelledby="model-access-bulk"
      className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark"
    >
      <h3
        id="model-access-bulk"
        className="text-sm font-semibold text-gray-900 dark:text-white"
      >
        {t('modelAccess.grid.bulk.title')}
      </h3>
      <AudienceTermsFields
        audiences={audiences}
        onAudiencesChange={setAudiences}
        terms={terms}
        onTermsChange={setTerms}
        disabled={disabled}
      />
      <fieldset>
        <legend className="mb-1 text-xs font-semibold text-gray-900 dark:text-white">
          {t('modelAccess.grid.bulk.models')}
        </legend>
        <div className="grid max-h-64 gap-x-6 gap-y-3 overflow-y-auto rounded-lg border border-gray-200 p-3 sm:grid-cols-2 xl:grid-cols-3 dark:border-gray-700">
          {sections.map((section) => (
            <ul key={section.key} className="space-y-1">
              {section.rows.map((row) => (
                <li key={row.key} className={row.isFamily ? '' : 'ps-6'}>
                  <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
                    <input
                      type="checkbox"
                      className={ADMIN_CHECKBOX}
                      checked={rowKeys.has(row.key)}
                      onChange={() => toggle(row.key)}
                      disabled={disabled}
                    />
                    <span className={row.isFamily ? 'font-semibold' : ''}>
                      {row.label}
                    </span>{' '}
                    {row.isFamily && (
                      <span className={ADMIN_MUTED}>
                        {t('modelAccess.grid.bulk.wholeFamily')}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          disabled={disabled || audiences.length === 0 || chosen.length === 0}
          onClick={() =>
            onApply(
              chosen.map((row) => row.dimension),
              audiences,
              terms,
            )
          }
        >
          {t('modelAccess.grid.bulk.apply', { count: chosen.length })}
        </button>
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={onCancel}
        >
          {t('cancel')}
        </button>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {t('modelAccess.grid.bulk.note')}
        </p>
      </div>
    </section>
  );
};

interface RowProps {
  row: GridRow;
  rules: ModelAccessRule[];
  defaults: LimitEntry[];
  columns: AudienceColumn[];
  audienceName: (audience: Audience) => string;
  columnCount: number;
  selected: ColumnKey | null;
  onSelect: (column: ColumnKey) => void;
  onClose: () => void;
  onChange: (rules: ModelAccessRule[]) => void;
  disabled: boolean;
}

/** One family or model: its cells, and its editor when selected. */
const Row: FC<RowProps> = ({
  row,
  rules,
  defaults,
  columns,
  audienceName,
  columnCount,
  selected,
  onSelect,
  onClose,
  onChange,
  disabled,
}) => {
  const t = useTranslations('limits');
  const requestsDef = getLimitDefinition('model.requests');
  const { dimension, series } = row;
  const rule = ruleFor(rules, dimension);
  const effective = effectiveAccessFor(dimension, series, defaults, rules);
  const collision = collidesWithDefaults(dimension, rule, defaults);
  const people = peopleCounts(rules, dimension, series);
  const ownDefault = rule?.defaultAccess !== undefined;
  const selectedColumn = columns.find((c) => columnId(c) === selected);

  const cellButton = (
    column: ColumnKey,
    audience: string,
    value: string,
    content: ReactNode,
  ) => (
    <td className="px-1 py-1">
      <button
        type="button"
        aria-pressed={selected === column}
        aria-label={t('modelAccess.grid.cellLabel', {
          model: row.label,
          audience,
          value,
        })}
        onClick={() => onSelect(column)}
        className={`flex min-h-9 w-full items-center rounded-md px-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          selected === column
            ? 'bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-950/50 dark:ring-blue-400'
            : 'hover:bg-gray-50 dark:hover:bg-gray-800'
        }`}
      >
        {content}
      </button>
    </td>
  );

  const everyoneText = stateLabel(t, effective.state);
  /** A cell's value in words; an inherited one says so, as its dashes do. */
  const inheritedText = (text: string): string =>
    `${text}, ${t('console.sr.inherited')}`;
  const audienceText = (cell: GridCell): string => {
    if (cell.kind === 'empty') return t('modelAccess.grid.noGrant');
    const text = termsLabel(t, cell.terms);
    return cell.kind === 'inherited' ? inheritedText(text) : text;
  };

  return (
    <>
      <tr className="border-t border-gray-100 first:border-t-0 dark:border-gray-800">
        <th
          scope="row"
          className={`py-2 pe-2 text-left ${row.isFamily ? 'ps-4 font-semibold' : 'ps-8 font-normal'} text-gray-900 dark:text-white`}
        >
          <span className="flex flex-wrap items-center gap-x-2">
            {row.label}
            {!row.known && (
              <span className={ADMIN_MUTED} title={t('unknownQualifierHint')}>
                {t('unknownQualifier')}
              </span>
            )}
            {collision && (
              <span className={ADMIN_CHIP_WARN}>
                {t('modelAccess.collisionChip')}
              </span>
            )}
          </span>
          {row.isFamily && (
            <span className="block text-[11px] font-normal text-gray-600 dark:text-gray-400">
              {t('modelAccess.grid.familyNote')}
            </span>
          )}
        </th>
        {cellButton(
          'everyone',
          t('modelAccess.defaultLabel'),
          ownDefault ? everyoneText : inheritedText(everyoneText),
          <ValueChip
            value={valueOfState(effective.state)}
            def={requestsDef}
            inherited={!ownDefault}
          />,
        )}
        {columns.map((column) => {
          const cell = audienceCell(rules, dimension, series, column);
          return (
            <Fragment key={columnId(column)}>
              {cellButton(
                columnId(column),
                audienceName(column),
                audienceText(cell),
                cell.kind === 'empty' ? (
                  <Empty />
                ) : (
                  <ValueChip
                    value={valueOfTerms(cell.terms)}
                    def={requestsDef}
                    inherited={cell.kind === 'inherited'}
                  />
                ),
              )}
            </Fragment>
          );
        })}
        {cellButton(
          'people',
          t('modelAccess.grid.col.people'),
          t('modelAccess.grid.peopleValue', {
            allowed: people.allowed + people.inheritedAllowed,
            blocked: people.blocked + people.inheritedBlocked,
          }),
          <span className="flex flex-wrap items-center gap-1">
            <PeopleCount
              own={people.allowed}
              inherited={people.inheritedAllowed}
            />
            <PeopleCount
              own={people.blocked}
              inherited={people.inheritedBlocked}
              blocked
            />
            {people.allowed +
              people.inheritedAllowed +
              people.blocked +
              people.inheritedBlocked ===
              0 && <Empty />}
          </span>,
        )}
        <td className="px-2 py-2 text-xs text-gray-800 dark:text-gray-200">
          <ReachText reach={reachOf(rules, defaults, dimension, series)} />
        </td>
      </tr>
      {selected !== null && (
        <tr>
          <td
            colSpan={columnCount}
            className="bg-blue-50/60 px-4 py-3 dark:bg-blue-950/20"
          >
            <RowEditor
              // Reopening from another column starts the adder afresh.
              key={selected}
              row={row}
              rules={rules}
              defaults={defaults}
              audienceName={audienceName}
              opening={selectedColumn}
              onClose={onClose}
              onChange={onChange}
              disabled={disabled}
            />
          </td>
        </tr>
      )}
    </>
  );
};

/**
 * Everything one row says, edited in one place: the answer for everyone
 * else, then every group, domain and person the row names in a single list
 * with one control each, and the field that adds more of any kind.
 */
const RowEditor: FC<{
  row: GridRow;
  rules: ModelAccessRule[];
  defaults: LimitEntry[];
  audienceName: (audience: Audience) => string;
  /** The audience column the editor was opened from, if any. */
  opening: AudienceColumn | undefined;
  onClose: () => void;
  onChange: (rules: ModelAccessRule[]) => void;
  disabled: boolean;
}> = ({
  row,
  rules,
  defaults,
  audienceName,
  opening,
  onClose,
  onChange,
  disabled,
}) => {
  const t = useTranslations('limits');
  const requestsDef = getLimitDefinition('model.requests');
  const { dimension, series } = row;
  const rule = ruleFor(rules, dimension);
  const entries = audienceEntries(rules, dimension, series);
  // Opened from an audience column the row says nothing in: that audience
  // is waiting in the field, so one choice of terms finishes the job.
  const [pending, setPending] = useState<Audience[]>(() =>
    opening &&
    !entries.some(
      (entry) =>
        entry.origin === 'own' &&
        audienceId(entry.audience) === audienceId(opening),
    )
      ? [opening]
      : [],
  );
  const [pendingTerms, setPendingTerms] = useState<AudienceTerms>(null);
  if (!requestsDef) return null;

  const effective = effectiveAccessFor(dimension, series, defaults, rules);
  const collision = collidesWithDefaults(dimension, rule, defaults);
  const ownDefault = rule?.defaultAccess !== undefined;
  /** What everyone else would get if this row set no default of its own. */
  const inheritedDefault = effectiveAccessFor(
    dimension,
    series,
    defaults,
    withDefaultAccess(rules, dimension, undefined),
  );
  const everyoneText = stateLabel(t, effective.state);
  const headingId = `model-access-editor-${row.key}`;

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4
          id={headingId}
          className="text-sm font-semibold text-gray-900 dark:text-white"
        >
          {t('modelAccess.audience.editorTitle', { model: row.label })}
        </h4>
        <button
          type="button"
          className={`ms-auto ${ADMIN_BTN_SECONDARY}`}
          onClick={onClose}
        >
          {t('modelAccess.doneEditing')}
        </button>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1 text-xs font-semibold text-gray-900 dark:text-white">
          <AudienceShape kind="everyone" />
          {t('modelAccess.defaultLabel')}
        </div>
        <ValueChoice
          def={requestsDef}
          label={t('modelAccess.grid.cellLabel', {
            model: row.label,
            audience: t('modelAccess.defaultLabel'),
            value: everyoneText,
          })}
          value={
            rule?.defaultAccess === undefined
              ? undefined
              : rule.defaultAccess === false
                ? 0
                : rule.defaultAccess
          }
          inherited={valueOfState(inheritedDefault.state)}
          onChange={(value) =>
            onChange(
              withDefaultAccess(
                rules,
                dimension,
                value === undefined ? undefined : termsOfValue(value),
              ),
            )
          }
          disabled={disabled}
        />
        <p className={ADMIN_HINT}>
          {ownDefault
            ? t('modelAccess.effectiveLabel', { state: everyoneText })
            : t('modelAccess.inheritedFrom', {
                state: everyoneText,
                origin: t(`modelAccess.origin.${effective.origin}` as never),
              })}
        </p>
        {collision && (
          <p className={ADMIN_HINT} role="status">
            {t('modelAccess.collisionWarning')}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div>
          <div className="text-xs font-semibold text-gray-900 dark:text-white">
            {t('modelAccess.audience.heading')}
          </div>
          <p className={ADMIN_HINT}>{t('modelAccess.audience.hint')}</p>
        </div>
        {entries.length === 0 ? (
          <p className={ADMIN_MUTED}>{t('modelAccess.audience.empty')}</p>
        ) : (
          <ul
            aria-label={t('modelAccess.audience.heading')}
            className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-surface-dark"
          >
            {entries.map((entry) => (
              <AudienceEntryRow
                key={`${entry.origin}:${audienceId(entry.audience)}`}
                entry={entry}
                name={audienceName(entry.audience)}
                onTermsChange={(terms) =>
                  onChange(
                    withAudienceTerms(rules, dimension, entry.audience, terms),
                  )
                }
                disabled={disabled}
              />
            ))}
          </ul>
        )}
        <div className="space-y-3 rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-600">
          <AudienceTermsFields
            audiences={pending}
            onAudiencesChange={setPending}
            terms={pendingTerms}
            onTermsChange={setPendingTerms}
            disabled={disabled}
          />
          <button
            type="button"
            className={ADMIN_BTN_PRIMARY}
            disabled={disabled || pending.length === 0}
            onClick={() => {
              onChange(
                withAudiencesTerms(rules, [dimension], pending, pendingTerms),
              );
              setPending([]);
            }}
          >
            {t('modelAccess.audience.add', { count: pending.length })}
          </button>
        </div>
      </div>
    </section>
  );
};

/** One named audience on a row: who, what they get, and removing them. */
const AudienceEntryRow: FC<{
  entry: AudienceEntry;
  name: string;
  /** `undefined` removes the entry. */
  onTermsChange: (terms: AudienceTerms | undefined) => void;
  disabled: boolean;
}> = ({ entry, name, onTermsChange, disabled }) => {
  const t = useTranslations('limits');
  const requestsDef = getLimitDefinition('model.requests');
  if (!requestsDef) return null;
  const own = entry.origin === 'own';
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
      <div className="flex min-w-[14rem] flex-1 items-baseline gap-1.5 text-sm text-gray-900 dark:text-white">
        <AudienceShape kind={entry.audience.scope} />
        <span className="[overflow-wrap:anywhere]">{name}</span>
        <span className={ADMIN_MUTED}>
          {t(`modelAccess.audience.kind.${entry.audience.scope}`)}
        </span>
        {entry.overruled && (
          <span className={ADMIN_CHIP_WARN}>
            {t('modelAccess.audience.overruled')}
          </span>
        )}
      </div>
      {own ? (
        <>
          <ValueChoice
            def={requestsDef}
            kinds={TERMS_KINDS}
            label={t('modelAccess.termsLabel', { target: name })}
            value={valueOfTerms(entry.terms)}
            inherited={null}
            onChange={(value) => onTermsChange(termsOfValue(value))}
            disabled={disabled}
          />
          <button
            type="button"
            className={ADMIN_BTN_ICON_DANGER}
            onClick={() => onTermsChange(undefined)}
            disabled={disabled}
            aria-label={t('modelAccess.removeGrant', { target: name })}
          >
            <IconTrash size={16} aria-hidden="true" />
          </button>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ValueChip
            value={valueOfTerms(entry.terms)}
            def={requestsDef}
            inherited
          />
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {t('modelAccess.audience.fromFamily')}
          </span>
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => onTermsChange(entry.terms)}
            disabled={disabled}
            aria-label={t('modelAccess.audience.setHereFor', { target: name })}
          >
            {t('modelAccess.audience.setHere')}
          </button>
        </div>
      )}
    </li>
  );
};

const Empty: FC = () => (
  <span aria-hidden="true" className="px-2 text-gray-300 dark:text-gray-600">
    ·
  </span>
);

/** People on a list: the row's own count solid, a family's dashed. */
const PeopleCount: FC<{
  own: number;
  inherited: number;
  blocked?: boolean;
}> = ({ own, inherited, blocked = false }) => {
  if (own === 0 && inherited === 0) return null;
  const base =
    'inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-semibold tabular-nums';
  return (
    <>
      {own > 0 && (
        <span
          className={`${base} ${
            blocked
              ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
              : 'border border-gray-900 bg-white text-gray-900 dark:border-gray-300 dark:bg-gray-900 dark:text-white'
          }`}
        >
          {blocked && <span aria-hidden="true">⊘</span>}
          {own}
        </span>
      )}
      {inherited > 0 && (
        <span
          className={`${base} border border-dashed border-gray-400 font-medium text-gray-600 dark:border-gray-500 dark:text-gray-400`}
        >
          <span aria-hidden="true">↓</span>
          {inherited}
        </span>
      )}
    </>
  );
};

const ReachText: FC<{ reach: Reach }> = ({ reach }) => {
  const t = useTranslations('limits');
  const list = (counts: AudienceCounts): string =>
    [
      counts.groups > 0
        ? t('modelAccess.groupsCount', { count: counts.groups })
        : null,
      counts.domains > 0
        ? t('modelAccess.domainsCount', { count: counts.domains })
        : null,
      counts.people > 0
        ? t('modelAccess.grid.reach.people', { count: counts.people })
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');
  switch (reach.kind) {
    case 'everyone':
      return <>{t('modelAccess.grid.reach.everyone')}</>;
    case 'everyoneBut':
      return (
        <>{t('modelAccess.grid.reach.everyoneExcept', { list: list(reach) })}</>
      );
    case 'nobody':
      return <>{t('modelAccess.grid.reach.nobody')}</>;
    case 'listed':
      return <>{list(reach)}</>;
  }
};

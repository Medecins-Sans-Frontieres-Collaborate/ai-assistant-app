'use client';

import { IconPlus } from '@tabler/icons-react';
import { FC, Fragment, ReactNode, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useGroupNames } from '@/client/hooks/useGroupNames';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import type {
  LimitEntry,
  LimitValue,
  LimitsMode,
  ModelAccessRule,
} from '@/lib/services/limits/types';

import {
  AudienceColumn,
  GridCell,
  Reach,
  audienceCell,
  audienceColumns,
  columnId,
  peopleLists,
  reachOf,
  withAudienceGrant,
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
  emptyRule,
  externalFamilyLabels,
  ruleFor,
  upsertRule,
} from '@/lib/utils/app/modelAccessTree';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_SECONDARY,
  ADMIN_CHIP_WARN,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { ChipListInput } from '@/components/AgentAccess/ChipListInput';
import { GroupSearchPicker } from '@/components/AgentAccess/GroupSearchPicker';
import { normalizeDomainEntry } from '@/components/AgentAccess/RuleEditor';
import { ModelAccessGrantList } from '@/components/Limits/ModelAccessGrantList';
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

/** The column of the selected cell: a fixed one, or an audience column id. */
type ColumnKey = 'everyone' | 'allow' | 'deny' | string;

/** A grant has no "off": blocking is the block list's job. */
const GRANT_KINDS: readonly ValueKind[] = ['inherit', 'limit', 'unlimited'];

/** A state as the value the shared chips and control understand (0 = off). */
function valueOfState(state: AccessState): LimitValue {
  if (state.kind === 'unavailable') return 0;
  return state.kind === 'unlimited' ? null : state.requests;
}

/** A state in words: "Unlimited", "Limited to 50 / day", "Unavailable". */
function stateLabel(
  t: (key: string, values?: Record<string, string | number>) => string,
  state: AccessState,
): string {
  if (state.kind === 'limited') {
    return t('modelAccess.state.limited', { requests: state.requests });
  }
  return t(`modelAccess.state.${state.kind}`);
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
 * family sets there, dashed. Selecting a cell opens the same Inherit / Limit
 * / Unlimited / Off control as every other limits screen.
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
  /** Columns added this session that hold no grant yet. */
  const [addedColumns, setAddedColumns] = useState<AudienceColumn[]>([]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<{
    row: string;
    column: ColumnKey;
  } | null>(null);
  const columns = useMemo(
    () => audienceColumns(rules, addedColumns),
    [rules, addedColumns],
  );
  const groupNames = useGroupNames(
    columns.filter((c) => c.scope === 'group').map((c) => c.target),
  );
  const columnLabel = (column: AudienceColumn): string =>
    column.scope === 'group'
      ? (groupNames[column.target] ?? column.target)
      : column.target;

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
  const columnCount = columns.length + 5;

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
          <p className={ADMIN_MUTED}>{t('modelAccess.grid.intro')}</p>
          {external.length > 0 && (
            <p className={ADMIN_MUTED}>
              {t('modelAccess.externalNote', { families: external.join(', ') })}
            </p>
          )}
        </div>
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={() => setAdding((value) => !value)}
          aria-expanded={adding}
          disabled={disabled}
        >
          <IconPlus size={16} aria-hidden="true" />
          {t('modelAccess.grid.addColumn')}
        </button>
      </div>
      {adding && (
        <AddColumnForm
          onAdd={(column) => {
            setAddedColumns((current) => [...current, column]);
            setAdding(false);
          }}
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
                    {columnLabel(column)}
                  </ColumnHeading>
                ))}
                <ColumnHeading kind="user">
                  {t('modelAccess.list.allow')}
                </ColumnHeading>
                <ColumnHeading>{t('modelAccess.list.deny')}</ColumnHeading>
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
                    columnLabel={columnLabel}
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
          <li>{t('modelAccess.grid.how.block')}</li>
          <li>{t('modelAccess.grid.how.specific')}</li>
          <li>{t('modelAccess.grid.how.inherit')}</li>
          <li>{t('modelAccess.grid.how.envelope')}</li>
        </ol>
      </section>
    </div>
  );
};

const ColumnHeading: FC<{
  kind?: 'everyone' | 'group' | 'domain' | 'user';
  children: ReactNode;
}> = ({ kind, children }) => (
  <th scope="col" className="min-w-[9rem] px-2 py-2 font-semibold">
    <span className="inline-flex items-center gap-1 [overflow-wrap:anywhere]">
      {kind ? <AudienceShape kind={kind} /> : <span aria-hidden="true">⊘</span>}
      {children}
    </span>
  </th>
);

/** Form for a new audience column: a security group or a domain. */
const AddColumnForm: FC<{ onAdd: (column: AudienceColumn) => void }> = ({
  onAdd,
}) => {
  const t = useTranslations('limits');
  const [scope, setScope] = useState<AudienceColumn['scope']>('group');
  const [domain, setDomain] = useState('');
  const addDomain = () => {
    const target = normalizeDomainEntry(domain).toLowerCase();
    if (target) onAdd({ scope: 'domain', target });
  };
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
          {t('modelAccess.grid.columnKind')}
          <select
            className={ADMIN_FIELD}
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as AudienceColumn['scope'])
            }
          >
            <option value="group">{t('scope.group')}</option>
            <option value="domain">{t('scope.domain')}</option>
          </select>
        </label>
        {scope === 'domain' && (
          <>
            <input
              type="text"
              className={`min-w-[16rem] ${ADMIN_FIELD}`}
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addDomain();
              }}
              placeholder={t('targetsPlaceholder.domain')}
              aria-label={t('targetsPlaceholder.domain')}
            />
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={addDomain}
              disabled={!normalizeDomainEntry(domain)}
            >
              {t('modelAccess.grid.addColumnConfirm')}
            </button>
          </>
        )}
      </div>
      {scope === 'group' && (
        <div className="max-w-xl">
          <GroupSearchPicker
            values={[]}
            onChange={(added) => {
              if (added[0]) onAdd({ scope: 'group', target: added[0] });
            }}
            labels={{
              searchPlaceholder: t('groupSearchPlaceholder'),
              searchHint: t('groupSearchHint'),
              noResults: t('groupSearchNoResults'),
              searchError: t('groupSearchError'),
              chipPlaceholder: t('targetsPlaceholder.group'),
              addHint: t('chipAddHint'),
              removeLabel: t('removeChip'),
              flagOffHint: t('groupsFlagOff'),
            }}
          />
        </div>
      )}
      <p className={ADMIN_HINT}>{t('modelAccess.grid.addColumnHint')}</p>
    </div>
  );
};

interface RowProps {
  row: GridRow;
  rules: ModelAccessRule[];
  defaults: LimitEntry[];
  columns: AudienceColumn[];
  columnLabel: (column: AudienceColumn) => string;
  columnCount: number;
  selected: ColumnKey | null;
  onSelect: (column: ColumnKey) => void;
  onClose: () => void;
  onChange: (rules: ModelAccessRule[]) => void;
  disabled: boolean;
}

/** One family or model: its cells, and the editor for the selected one. */
const Row: FC<RowProps> = ({
  row,
  rules,
  defaults,
  columns,
  columnLabel,
  columnCount,
  selected,
  onSelect,
  onClose,
  onChange,
  disabled,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const requestsDef = getLimitDefinition('model.requests');
  const { dimension, series } = row;
  const rule = ruleFor(rules, dimension);
  const effective = effectiveAccessFor(dimension, series, defaults, rules);
  const collision = collidesWithDefaults(dimension, rule, defaults);
  const lists = peopleLists(rules, dimension, series);
  const ownDefault = rule?.defaultAccess !== undefined;
  /** What everyone else would get if this row set no default of its own. */
  const inheritedDefault = effectiveAccessFor(
    dimension,
    series,
    defaults,
    withDefaultAccess(rules, dimension, undefined),
  );
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
    const text =
      cell.requests === null
        ? t('modelAccess.state.unlimited')
        : t('modelAccess.state.limited', { requests: cell.requests });
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
                columnLabel(column),
                audienceText(cell),
                cell.kind === 'empty' ? (
                  <Empty />
                ) : (
                  <ValueChip
                    value={cell.requests}
                    def={requestsDef}
                    inherited={cell.kind === 'inherited'}
                  />
                ),
              )}
            </Fragment>
          );
        })}
        {cellButton(
          'allow',
          t('modelAccess.list.allow'),
          String(lists.allow + lists.inheritedAllow),
          <PeopleCount own={lists.allow} inherited={lists.inheritedAllow} />,
        )}
        {cellButton(
          'deny',
          t('modelAccess.list.deny'),
          String(lists.deny + lists.inheritedDeny),
          <PeopleCount
            own={lists.deny}
            inherited={lists.inheritedDeny}
            blocked
          />,
        )}
        <td className="px-2 py-2 text-xs text-gray-800 dark:text-gray-200">
          <ReachText reach={reachOf(rules, defaults, dimension, series)} />
        </td>
      </tr>
      {selected !== null && (
        <tr>
          <td
            colSpan={columnCount}
            className="space-y-3 bg-blue-50/60 px-4 py-3 dark:bg-blue-950/20"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                {row.label}
                {' · '}
                {selected === 'everyone'
                  ? t('modelAccess.defaultLabel')
                  : selected === 'allow'
                    ? t('modelAccess.list.allow')
                    : selected === 'deny'
                      ? t('modelAccess.list.deny')
                      : selectedColumn
                        ? columnLabel(selectedColumn)
                        : ''}
              </h4>
              <button
                type="button"
                className={`ms-auto ${ADMIN_BTN_SECONDARY}`}
                onClick={onClose}
              >
                {t('modelAccess.doneEditing')}
              </button>
            </div>

            {selected === 'everyone' && requestsDef && (
              <>
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
                        value === undefined
                          ? undefined
                          : value === null || value === true
                            ? null
                            : value === 0 || value === false
                              ? false
                              : value,
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
                        origin: t(
                          `modelAccess.origin.${effective.origin}` as never,
                        ),
                      })}
                </p>
                {collision && (
                  <p className={ADMIN_HINT} role="status">
                    {t('modelAccess.collisionWarning')}
                  </p>
                )}
              </>
            )}

            {selectedColumn && requestsDef && (
              <AudienceEditor
                row={row}
                rules={rules}
                column={selectedColumn}
                columnLabel={columnLabel(selectedColumn)}
                fallback={valueOfState(effective.state)}
                onChange={onChange}
                disabled={disabled}
              />
            )}

            {selected === 'allow' && (
              <>
                <ModelAccessGrantList
                  kind="allow"
                  grants={rule?.allow ?? []}
                  onChange={(allow) =>
                    onChange(
                      upsertRule(rules, dimension, {
                        ...(rule ?? emptyRule(dimension)),
                        allow,
                      }),
                    )
                  }
                  disabled={disabled}
                />
                {lists.inheritedAllow > 0 && (
                  <p className={ADMIN_HINT}>
                    {t('modelAccess.grid.inheritedPeople', {
                      count: lists.inheritedAllow,
                    })}
                  </p>
                )}
              </>
            )}

            {selected === 'deny' && (
              <>
                <p className={ADMIN_HINT}>{t('modelAccess.listHint.deny')}</p>
                <ChipListInput
                  values={rule?.deny ?? []}
                  onChange={(deny) =>
                    onChange(
                      upsertRule(rules, dimension, {
                        ...(rule ?? emptyRule(dimension)),
                        deny,
                      }),
                    )
                  }
                  placeholder={t('targetsPlaceholder.user')}
                  addHint={t('chipAddHint')}
                  removeLabel={t('removeChip')}
                  disabled={disabled}
                  suggest={peopleSuggest}
                  suggestionsLabel={tPeople('listLabel')}
                  chipTone={() => 'danger'}
                />
                {lists.inheritedDeny > 0 && (
                  <p className={ADMIN_HINT}>
                    {t('modelAccess.grid.inheritedPeople', {
                      count: lists.inheritedDeny,
                    })}
                  </p>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
};

/** The terms one group or domain gets on one row. */
const AudienceEditor: FC<{
  row: GridRow;
  rules: ModelAccessRule[];
  column: AudienceColumn;
  columnLabel: string;
  /** What members get with no grant anywhere: the everyone-else answer. */
  fallback: LimitValue;
  onChange: (rules: ModelAccessRule[]) => void;
  disabled: boolean;
}> = ({ row, rules, column, columnLabel, fallback, onChange, disabled }) => {
  const t = useTranslations('limits');
  const requestsDef = getLimitDefinition('model.requests');
  if (!requestsDef) return null;
  const cell = audienceCell(rules, row.dimension, row.series, column);
  const familyCell =
    row.dimension.modelId && row.series
      ? audienceCell(rules, { series: row.series }, undefined, column)
      : { kind: 'empty' as const };
  return (
    <>
      <ValueChoice
        def={requestsDef}
        kinds={GRANT_KINDS}
        label={t('modelAccess.grid.cellLabel', {
          model: row.label,
          audience: columnLabel,
          value: '',
        })}
        value={cell.kind === 'set' ? cell.requests : undefined}
        inherited={familyCell.kind === 'set' ? familyCell.requests : fallback}
        onChange={(value) =>
          onChange(
            withAudienceGrant(
              rules,
              row.dimension,
              column,
              value === undefined
                ? undefined
                : typeof value === 'number'
                  ? value
                  : null,
            ),
          )
        }
        disabled={disabled}
      />
      <p className={ADMIN_HINT}>
        {t(
          familyCell.kind === 'set'
            ? 'modelAccess.grid.grantHintFamily'
            : 'modelAccess.grid.grantHint',
        )}
      </p>
    </>
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
  if (own === 0 && inherited === 0) return <Empty />;
  const base =
    'inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-semibold tabular-nums';
  return (
    <span className="flex flex-wrap items-center gap-1">
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
    </span>
  );
};

const ReachText: FC<{ reach: Reach }> = ({ reach }) => {
  const t = useTranslations('limits');
  switch (reach.kind) {
    case 'everyone':
      return <>{t('modelAccess.grid.reach.everyone')}</>;
    case 'everyoneBut':
      return (
        <>{t('modelAccess.grid.reach.everyoneBut', { count: reach.blocked })}</>
      );
    case 'nobody':
      return <>{t('modelAccess.grid.reach.nobody')}</>;
    case 'listed':
      return (
        <>
          {[
            reach.groups > 0
              ? t('modelAccess.groupsCount', { count: reach.groups })
              : null,
            reach.domains > 0
              ? t('modelAccess.domainsCount', { count: reach.domains })
              : null,
            reach.people > 0
              ? t('modelAccess.grid.reach.people', { count: reach.people })
              : null,
          ]
            .filter((part): part is string => part !== null)
            .join(', ')}
        </>
      );
  }
};

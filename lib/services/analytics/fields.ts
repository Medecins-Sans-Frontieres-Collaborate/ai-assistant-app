/**
 * Which fields of a delivered report the platform may show (design §6.4).
 * Pure and client-importable.
 *
 * The policy is set on FIELDS, not column names, because the same information
 * travels under several names: job title is the `UserJobTitle` column on the
 * per-user sheets and the VALUE of `top_job_title` on the summary sheet.
 *
 * Three classes:
 *  - identifiers  — never shown outside `raw/`; a code constant, the policy
 *                   cannot enable them, and their presence quarantines a file;
 *  - catalog fields — shown by default, hideable platform-wide (global
 *                   admins) and, tighten-only, per folder;
 *  - unclassified — a text column the catalog does not know. Hidden until an
 *                   admin maps it to a field, so a column the ETL adds later
 *                   never appears by default.
 *
 * Numeric, boolean and date columns are measures: they are never classified
 * and never hidden.
 */
import { FolderIndex } from '@/lib/services/analytics/access';
import { folderChain } from '@/lib/services/analytics/paths';
import {
  AnalyticsFieldPolicyDocument,
  AnalyticsFileState,
} from '@/lib/services/analytics/types';

export const ANALYTICS_FIELD_IDS = [
  'userCode',
  'jobTitle',
  'department',
  'company',
  'orgGroup',
  'section',
  'mailDomain',
  'workLocation',
  'technical',
  'other',
] as const;
export type AnalyticsFieldId = (typeof ANALYTICS_FIELD_IDS)[number];

export function isAnalyticsFieldId(value: string): value is AnalyticsFieldId {
  return (ANALYTICS_FIELD_IDS as readonly string[]).includes(value);
}

/** Lowercased, whitespace-collapsed header — the key columns are matched on. */
export function normalizeColumnName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Columns the catalog knows, by normalized header. `technical` gathers the
 * descriptors that say nothing about a person (model, region, currency…);
 * `other` has no built-in columns — it is where an admin files a leftover.
 */
const CATALOG: Record<AnalyticsFieldId, readonly string[]> = {
  userCode: ['userid', 'user code', 'user_code', 'usercode'],
  jobTitle: ['userjobtitle', 'job title', 'jobtitle', 'top_job_title'],
  department: ['userdepartment', 'department', 'top_department'],
  company: [
    'usercompanyname',
    'company',
    'org',
    'company names seen (audit)',
    'company names typed by those users',
  ],
  orgGroup: ['orggroup', 'slice'],
  section: ['section'],
  mailDomain: ['mail domain'],
  workLocation: ['worklocation', 'work location'],
  technical: [
    'eventtype',
    'modelused',
    'model',
    'size class',
    'region',
    'reasoning effort',
    'currency',
    'basis',
    'line',
    'note',
  ],
  other: [],
};

const CATALOG_BY_COLUMN: ReadonlyMap<string, AnalyticsFieldId> = new Map(
  (Object.entries(CATALOG) as [AnalyticsFieldId, readonly string[]][]).flatMap(
    ([field, columns]) => columns.map((column) => [column, field] as const),
  ),
);

/**
 * Direct identifiers, by normalized header. A non-raw file carrying any of
 * these is quarantined; nothing in the policy can make one visible.
 */
const IDENTIFIER_COLUMNS: ReadonlySet<string> = new Set([
  'useremail',
  'usermail',
  'email',
  'e-mail',
  'mail',
  'userprincipalname',
  'upn',
  'userdisplayname',
  'displayname',
  'display name',
  'usergivenname',
  'givenname',
  'given name',
  'first name',
  'usersurname',
  'surname',
  'last name',
  'full name',
  'username',
  'user name',
  'userobjectid',
  'objectid',
  'object id',
  'oid',
  'filename',
  'file name',
  'errormessage',
  'error message',
]);

export function isIdentifierColumn(name: string): boolean {
  return IDENTIFIER_COLUMNS.has(normalizeColumnName(name));
}

/** The pseudonymous user code the contract requires: `u-` + hex. */
export const USER_CODE_PATTERN = /^u-[0-9a-f]{6,}$/i;

/**
 * The field a column belongs to: the catalog first, then the admin's own
 * classification, else null (unclassified). The catalog wins so a stored
 * mapping can never re-label a column the code already understands.
 */
export function classifyColumn(
  name: string,
  policy: Pick<AnalyticsFieldPolicyDocument, 'columns'> | null,
): AnalyticsFieldId | null {
  const key = normalizeColumnName(name);
  const builtIn = CATALOG_BY_COLUMN.get(key);
  if (builtIn) return builtIn;
  const stored = policy?.columns[key];
  return stored && isAnalyticsFieldId(stored) ? stored : null;
}

/** Fields hidden for a folder: the platform policy ∪ every ancestor's extras. */
export function effectiveHiddenFields(
  folderPath: string,
  folders: FolderIndex,
  policy: Pick<AnalyticsFieldPolicyDocument, 'hidden'> | null,
): Set<AnalyticsFieldId> {
  const hidden = new Set<AnalyticsFieldId>();
  for (const field of policy?.hidden ?? []) {
    if (isAnalyticsFieldId(field)) hidden.add(field);
  }
  for (const path of folderChain(folderPath)) {
    for (const field of folders.get(path)?.hiddenFields ?? []) {
      if (isAnalyticsFieldId(field)) hidden.add(field);
    }
  }
  return hidden;
}

export interface FileFieldSummary {
  /** Catalog fields the file contains. */
  fields: AnalyticsFieldId[];
  /** Text columns no one has classified yet (original header names). */
  unclassified: string[];
}

/** Classifies a validated file's columns against the CURRENT policy. */
export function summarizeFileFields(
  state: Pick<AnalyticsFileState, 'columns' | 'declaredFields'>,
  policy: Pick<AnalyticsFieldPolicyDocument, 'columns'> | null,
): FileFieldSummary {
  const fields = new Set<AnalyticsFieldId>();
  const unclassified: string[] = [];
  for (const declared of state.declaredFields) {
    if (isAnalyticsFieldId(declared)) fields.add(declared);
  }
  for (const column of state.columns) {
    const field = classifyColumn(column, policy);
    if (field) fields.add(field);
    else unclassified.push(column);
  }
  return { fields: [...fields], unclassified };
}

export type OriginalRestriction =
  | 'hidden-fields'
  | 'unclassified-fields'
  | 'not-inspected';

/**
 * Why a non-admin may NOT download the delivered file as-is, or null when
 * they may. The delivered file cannot be edited in place, so a file that
 * contains a hidden (or not-yet-classified) field is admin-only in its
 * original form.
 */
export function originalRestriction(
  state: Pick<AnalyticsFileState, 'columns' | 'declaredFields' | 'inspected'>,
  hidden: ReadonlySet<AnalyticsFieldId>,
  policy: Pick<AnalyticsFieldPolicyDocument, 'columns'> | null,
): OriginalRestriction | null {
  if (!state.inspected) return 'not-inspected';
  const { fields, unclassified } = summarizeFileFields(state, policy);
  if (unclassified.length > 0) return 'unclassified-fields';
  if (fields.some((field) => hidden.has(field))) return 'hidden-fields';
  return null;
}

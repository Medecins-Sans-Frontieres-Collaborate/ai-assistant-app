import { Session } from 'next-auth';

import { FieldValue, FormField, FormTemplate } from '@/types/formFill';

/**
 * Admin-controlled values (docs/DOCUMENT_FILL_ASSESSMENT.md §4a): locked
 * fields and prefills. Pure and shared by client and server; the server
 * applies it with the ADMIN copy of the template at render time so a
 * tampered client snapshot cannot change an admin-fixed value.
 */

export interface PrefillUser {
  displayName?: string;
  email?: string;
  department?: string;
  jobTitle?: string;
  officeLocation?: string;
}

export function prefillUserFromSession(user: Session['user']): PrefillUser {
  return {
    displayName: user.displayName,
    email: user.mail,
    department: user.department,
    jobTitle: user.jobTitle,
    officeLocation: user.officeName ?? undefined,
  };
}

/** The value an admin prefill resolves to, or null when it has none. */
export function resolvePrefill(
  field: FormField,
  user: PrefillUser | undefined,
): FieldValue {
  const prefill = field.admin?.prefill;
  if (!prefill) return null;
  if (prefill.kind === 'constant') {
    return prefill.value.trim() === '' ? null : prefill.value;
  }
  const value = user?.[prefill.attribute];
  return value && value.trim() !== '' ? value : null;
}

/**
 * Overrides the caller's values for every LOCKED field with the admin
 * template's own answer (prefill or nothing). Fields the admin locked with
 * no prefill are cleared — a locked blank is the admin's decision too.
 */
export function applyLockedValues(
  adminTemplate: FormTemplate,
  values: Record<string, string | boolean>,
  user: PrefillUser | undefined,
): Record<string, string | boolean> {
  const out = { ...values };
  for (const field of adminTemplate.fields) {
    if (!field.admin?.locked) continue;
    const resolved = resolvePrefill(field, user);
    if (resolved === null) delete out[field.id];
    else if (typeof resolved === 'boolean') out[field.id] = resolved;
    else
      out[field.id] = Array.isArray(resolved)
        ? resolved.join('\n')
        : String(resolved);
  }
  return out;
}

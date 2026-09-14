import {
  FORM_LIMITS,
  FieldValidation,
  FieldValue,
  FormField,
  FormFieldType,
} from '@/types/formFill';

/**
 * Deterministic field validation — client-safe, pure, never involves the
 * model. Issues are CODES with params so the UI can localize them; the
 * `rubric` rule is the one model-judged rule and is deliberately not here
 * (it lands as `gaps` on the fill).
 */
export interface FieldIssue {
  code:
    | 'required'
    | 'minChars'
    | 'maxChars'
    | 'minWords'
    | 'maxWords'
    | 'pattern'
    | 'enum'
    | 'min'
    | 'max'
    | 'dateAfter'
    | 'dateBefore'
    | 'minItems'
    | 'type';
  params?: Record<string, string>;
}

export function isListType(type: FormFieldType): boolean {
  return type.startsWith('list<');
}

/** True when the value carries nothing — the ledger's "empty". */
export function isEmptyValue(value: FieldValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) {
    return value.filter((v) => String(v ?? '').trim() !== '').length === 0;
  }
  return false;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD that exists on the calendar (Date.parse rolls 02-30 over). */
export function isCalendarDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === text;
}

function countWords(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
}

/**
 * Rejects patterns that can backtrack catastrophically: a quantified
 * group whose body is itself quantified (`(a+)+`, `(\\d*)*`, `(x{2,})+`).
 * Patterns run synchronously on the server for every fill and in every
 * viewer's browser, so an author (or a hostile template) must not be able
 * to hang either. Conservative by design; ordinary form patterns pass.
 */
export function isSafePattern(source: string): boolean {
  if (source.length > 500) return false;
  const stack: boolean[] = []; // per open group: "body contains a quantifier"
  let inClass = false;
  let unsafe = false;
  const isQuantifier = (ch: string) => ch === '*' || ch === '+' || ch === '{';
  for (let i = 0; i < source.length && !unsafe; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push(false);
      continue;
    }
    if (ch === ')') {
      const hadQuantifier = stack.pop() ?? false;
      const next = source[i + 1];
      if (hadQuantifier && next && isQuantifier(next)) unsafe = true;
      // A quantified group counts as a quantifier for its parent.
      if (stack.length > 0 && next && (isQuantifier(next) || next === '?')) {
        stack[stack.length - 1] = true;
      }
      continue;
    }
    if (isQuantifier(ch) && stack.length > 0) stack[stack.length - 1] = true;
  }
  return !unsafe;
}

/**
 * Compiles a template pattern anchored to the whole value. Tries the `u`
 * flag first (Unicode classes), then plain (escapes like `\\-` outside a
 * class are legal only there). Null when it cannot compile or is unsafe —
 * an unusable rule must not silently pass every value, so the schema
 * rejects it at write time too (templateSchema).
 */
export function compilePattern(source: string): RegExp | null {
  if (!isSafePattern(source)) return null;
  for (const flags of ['u', '']) {
    try {
      return new RegExp(`^(?:${source})$`, flags);
    } catch {
      // try the next flag set
    }
  }
  return null;
}

const safeRegex = compilePattern;

function validateText(
  raw: string,
  rules: FieldValidation,
  issues: FieldIssue[],
): void {
  // Values are capped everywhere they are minted; an oversized value from
  // a hand-edited request is still bounded here before any regex runs.
  const text = raw.slice(0, FORM_LIMITS.MAX_VALUE_CHARS);
  const chars = text.trim().length;
  if (rules.minChars !== undefined && chars < rules.minChars) {
    issues.push({ code: 'minChars', params: { min: String(rules.minChars) } });
  }
  if (rules.maxChars !== undefined && chars > rules.maxChars) {
    issues.push({ code: 'maxChars', params: { max: String(rules.maxChars) } });
  }
  const words = countWords(text);
  if (rules.minWords !== undefined && words < rules.minWords) {
    issues.push({ code: 'minWords', params: { min: String(rules.minWords) } });
  }
  if (rules.maxWords !== undefined && words > rules.maxWords) {
    issues.push({ code: 'maxWords', params: { max: String(rules.maxWords) } });
  }
  if (rules.pattern) {
    const re = safeRegex(rules.pattern);
    if (re && !re.test(text.trim())) {
      issues.push({ code: 'pattern', params: { pattern: rules.pattern } });
    }
  }
}

/**
 * Validates a field's current value. An empty value on a required field is
 * the only issue an empty value can have; every other rule needs a value.
 */
export function validateField(
  field: FormField,
  value: FieldValue | undefined,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (isEmptyValue(value)) {
    if (field.required) issues.push({ code: 'required' });
    return issues;
  }
  const rules = field.validation ?? {};
  const enumValues = rules.enumValues?.length ? rules.enumValues : undefined;

  switch (field.type) {
    case 'text':
    case 'longtext': {
      if (typeof value !== 'string') {
        issues.push({ code: 'type', params: { expected: field.type } });
        break;
      }
      validateText(value, rules, issues);
      if (enumValues && !enumValues.includes(value.trim())) {
        issues.push({ code: 'enum' });
      }
      break;
    }
    case 'enum': {
      if (typeof value !== 'string') {
        issues.push({ code: 'type', params: { expected: field.type } });
        break;
      }
      if (enumValues && !enumValues.includes(value.trim())) {
        issues.push({ code: 'enum' });
      }
      break;
    }
    case 'number': {
      const num = typeof value === 'number' ? value : Number(value);
      if (typeof value === 'boolean' || Number.isNaN(num)) {
        issues.push({ code: 'type', params: { expected: 'number' } });
        break;
      }
      if (rules.min !== undefined && num < rules.min) {
        issues.push({ code: 'min', params: { min: String(rules.min) } });
      }
      if (rules.max !== undefined && num > rules.max) {
        issues.push({ code: 'max', params: { max: String(rules.max) } });
      }
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        const text = String(value).trim().toLowerCase();
        if (!['true', 'false', 'yes', 'no', '1', '0'].includes(text)) {
          issues.push({ code: 'type', params: { expected: 'boolean' } });
        }
      }
      break;
    }
    case 'date': {
      const text = String(value).trim();
      if (!isCalendarDate(text)) {
        issues.push({ code: 'type', params: { expected: 'date' } });
        break;
      }
      if (rules.dateAfter && text < rules.dateAfter) {
        issues.push({ code: 'dateAfter', params: { date: rules.dateAfter } });
      }
      if (rules.dateBefore && text > rules.dateBefore) {
        issues.push({
          code: 'dateBefore',
          params: { date: rules.dateBefore },
        });
      }
      break;
    }
    case 'list<text>':
    case 'list<longtext>':
    case 'list<number>': {
      const items = Array.isArray(value) ? value : [String(value)];
      const kept = items.filter((v) => String(v ?? '').trim() !== '');
      if (rules.minItems !== undefined && kept.length < rules.minItems) {
        issues.push({
          code: 'minItems',
          params: { min: String(rules.minItems) },
        });
      }
      if (field.type === 'list<number>') {
        if (kept.some((v) => Number.isNaN(Number(v)))) {
          issues.push({ code: 'type', params: { expected: 'number' } });
        }
      } else {
        for (const item of kept) validateText(String(item), rules, issues);
      }
      break;
    }
  }
  return issues;
}

/**
 * Coerces raw user input (always a string from an input) into the field's
 * value type. Never throws: unparseable input stays a string so the
 * validator can flag it rather than the value silently vanishing.
 */
export function coerceInput(field: FormField, raw: string): FieldValue {
  const text = raw.trim();
  if (text === '') return null;
  switch (field.type) {
    case 'number': {
      const num = Number(text.replace(/,/g, ''));
      return Number.isNaN(num) ? text : num;
    }
    case 'boolean': {
      const lower = text.toLowerCase();
      if (['true', 'yes', '1', 'y'].includes(lower)) return true;
      if (['false', 'no', '0', 'n'].includes(lower)) return false;
      return text;
    }
    case 'list<text>':
    case 'list<longtext>':
    case 'list<number>':
      return raw
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
        .filter((line) => line !== '');
    default:
      return raw.replace(/\s+$/, '');
  }
}

/** Renders a value as the string an input or a document shows. */
export function formatValue(value: FieldValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(String).join('\n');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

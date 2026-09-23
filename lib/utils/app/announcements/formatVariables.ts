/**
 * Renders an announcement's typed variables for ONE reader
 * (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §5).
 *
 * Times are stored as instants and rendered here, in the reader's locale and
 * timezone, showing BOTH clocks by default:
 *
 *   12 Oct 2026, 14:00 – 18:00 UTC (16:00 – 20:00 your time)
 *
 * No user setting and no ambiguity: UTC is what the admin and everyone else
 * can quote to each other, local time is what the reader actually needs.
 * When the reader's clock reads the same as UTC the parenthesis is dropped.
 *
 * Pure: locale, timezone and the "your time" wording are passed in, so the
 * admin preview can render any locale and any timezone.
 */
import { AnnouncementVariable } from '@/lib/services/announcements/types';

export interface VariableFormatOptions {
  locale: string;
  /** IANA zone of the reader; defaults to the runtime's. */
  timeZone?: string;
  /** Localized wrapper for the local clock, e.g. "{time} your time". */
  localTimeTemplate: string;
}

function safeFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    // An unknown locale or zone must never blank a banner.
    return new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' });
  }
}

function formatInstant(at: Date, options: VariableFormatOptions): string {
  const full = (timeZone: string | undefined): string =>
    safeFormatter(options.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(at);
  const utc = full('UTC');
  const localFull = full(options.timeZone);
  if (utc === localFull) return `${utc} UTC`;

  // Same calendar day for the reader → the local CLOCK alone is enough.
  const dayIn = (timeZone: string | undefined): string =>
    safeFormatter('en', { dateStyle: 'short', timeZone }).format(at);
  const local =
    dayIn('UTC') === dayIn(options.timeZone)
      ? safeFormatter(options.locale, {
          timeStyle: 'short',
          timeZone: options.timeZone,
        }).format(at)
      : localFull;
  return `${utc} UTC (${options.localTimeTemplate.replace('{time}', local)})`;
}

function formatRange(
  from: Date,
  to: Date,
  options: VariableFormatOptions,
): string {
  const range = (timeZone: string | undefined): string => {
    const formatter = safeFormatter(options.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    });
    return typeof formatter.formatRange === 'function'
      ? formatter.formatRange(from, to)
      : `${formatter.format(from)} – ${formatter.format(to)}`;
  };
  const utc = range('UTC');
  const local = range(options.timeZone);
  if (utc === local) return `${utc} UTC`;
  return `${utc} UTC (${options.localTimeTemplate.replace('{time}', local)})`;
}

export function formatVariable(
  variable: AnnouncementVariable,
  options: VariableFormatOptions,
): string {
  switch (variable.type) {
    case 'instant':
      return formatInstant(new Date(variable.at), options);
    case 'timeRange':
      return formatRange(
        new Date(variable.from),
        new Date(variable.to),
        options,
      );
    case 'date':
      // A calendar date is the same for every reader: rendered in UTC so it
      // cannot slip a day for someone far from Greenwich.
      return safeFormatter(options.locale, {
        dateStyle: 'long',
        timeZone: 'UTC',
      }).format(new Date(variable.on));
  }
}

/** Substitutes every `{name}` with its rendered variable. */
export function formatAnnouncementText(
  text: string,
  variables: readonly AnnouncementVariable[],
  options: VariableFormatOptions,
): string {
  return text.replace(/\{([^{}]*)\}/g, (match, rawName: string) => {
    const variable = variables.find((v) => v.name === rawName.trim());
    if (!variable) return match;
    try {
      return formatVariable(variable, options);
    } catch {
      return match;
    }
  });
}

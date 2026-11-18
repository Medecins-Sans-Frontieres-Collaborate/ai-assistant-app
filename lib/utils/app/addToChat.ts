import {
  DOCUMENT_TRANSLATION_EXTENSIONS,
  TRANSCRIPTION_ACCEPT_TYPES,
} from '@/lib/constants/fileTypes';

/**
 * Rules for the "Add to chat" picker: which sources exist, which of them can
 * serve what the person is trying to do, and what can be done with a
 * selection. Pure, so the menu and the dialog agree by construction.
 *
 * Vocabulary used throughout:
 * - a SOURCE is a place content comes from (this device, a link, OneDrive…);
 * - an INTENT is what happens to it (attach it, translate it, transcribe it).
 */

/** What happens to the chosen content. */
export type AddIntent = 'attach' | 'translate' | 'transcribe';

/** A place content can be added from. */
export type AddSourceId =
  | 'device'
  | 'link'
  | 'camera'
  | 'onedrive'
  | 'mail'
  | 'meetings';

/** Every source, in the order the picker lists them. */
export const ADD_SOURCE_ORDER: readonly AddSourceId[] = [
  'device',
  'link',
  'camera',
  'onedrive',
  'mail',
  'meetings',
];

/** Every intent, in the order the "Then" control lists them. */
export const ADD_INTENT_ORDER: readonly AddIntent[] = [
  'attach',
  'translate',
  'transcribe',
];

/** Sources that read from Microsoft 365. */
export const M365_ADD_SOURCES: readonly AddSourceId[] = [
  'onedrive',
  'mail',
  'meetings',
];

/**
 * What this person can add from. Each Microsoft 365 entry is already the
 * product of its own feature flag AND the person's connect opt-in, so every
 * source switches on and off independently.
 */
export interface AddToChatCapabilities {
  /** The device has a camera the browser can use. */
  camera: boolean;
  /** Attach files from OneDrive / SharePoint. */
  m365Files: boolean;
  /** Import Outlook messages. */
  m365Mail: boolean;
  /** Import Teams meeting transcripts and recordings. */
  m365Meetings: boolean;
  /** Translate a document straight from OneDrive / SharePoint. */
  m365Translation: boolean;
}

/** Lowercase extensions, without the dot, that can be translated. */
export const TRANSLATABLE_EXTENSIONS: readonly string[] =
  DOCUMENT_TRANSLATION_EXTENSIONS.map((extension) =>
    extension.replace(/^\./, ''),
  );

/**
 * Lowercase extensions, without the dot, that can be transcribed. Derived
 * from the transcribe file input's accept list so the two cannot drift.
 */
export const TRANSCRIBABLE_EXTENSIONS: readonly string[] =
  TRANSCRIPTION_ACCEPT_TYPES.split(',')
    .filter((entry) => entry.startsWith('.'))
    .map((entry) => entry.slice(1).toLowerCase());

/** The lowercase extension of a file name, or '' when it has none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/** Whether a file with this name can be sent for document translation. */
export function isTranslatableName(fileName: string): boolean {
  return TRANSLATABLE_EXTENSIONS.includes(extensionOf(fileName));
}

/** Whether a file with this name is audio or video that can be transcribed. */
export function isTranscribableName(fileName: string): boolean {
  return TRANSCRIBABLE_EXTENSIONS.includes(extensionOf(fileName));
}

/**
 * Whether a source can serve an intent for this person.
 *
 * @param source - The place content would come from.
 * @param intent - What would happen to it.
 * @param capabilities - What this person can add from.
 * @returns True when picking from `source` can end in `intent`.
 */
export function sourceServesIntent(
  source: AddSourceId,
  intent: AddIntent,
  capabilities: AddToChatCapabilities,
): boolean {
  switch (source) {
    case 'device':
      return true;
    case 'link':
      return intent === 'attach';
    case 'camera':
      return intent === 'attach' && capabilities.camera;
    case 'onedrive':
      return intent === 'translate'
        ? capabilities.m365Translation
        : capabilities.m365Files;
    case 'mail':
      return intent === 'attach' && capabilities.m365Mail;
    case 'meetings':
      // A meeting offers a transcript to attach or a recording to transcribe.
      return intent !== 'translate' && capabilities.m365Meetings;
  }
}

/**
 * The sources to list in the picker: every source this person can use for at
 * least one intent. A source that cannot serve the CURRENT intent stays
 * listed (so the list does not jump around) and is shown disabled — see
 * {@link sourceServesIntent}.
 *
 * @param capabilities - What this person can add from.
 * @returns Source ids in display order.
 */
export function visibleSources(
  capabilities: AddToChatCapabilities,
): AddSourceId[] {
  return ADD_SOURCE_ORDER.filter((source) =>
    ADD_INTENT_ORDER.some((intent) =>
      sourceServesIntent(source, intent, capabilities),
    ),
  );
}

/**
 * Whether an intent needs the picker at all. With no Microsoft 365 source
 * to choose from, the device's own file dialog is the whole job and the
 * picker would only be an extra step in front of it.
 *
 * @param intent - What the person is about to do.
 * @param capabilities - What this person can add from.
 * @returns True when at least one Microsoft 365 source can serve the intent.
 */
export function needsPicker(
  intent: AddIntent,
  capabilities: AddToChatCapabilities,
): boolean {
  return M365_ADD_SOURCES.some((source) =>
    sourceServesIntent(source, intent, capabilities),
  );
}

/**
 * The source the picker opens on: the one used last time when it can still
 * serve the intent, otherwise this device.
 *
 * @param lastSource - The remembered source, if any (may be stale or from
 *   another build, so it is validated rather than trusted).
 * @param intent - What the person is about to do.
 * @param capabilities - What this person can add from.
 * @returns A source that has a pane and can serve the intent.
 */
export function initialSource(
  lastSource: string | null | undefined,
  intent: AddIntent,
  capabilities: AddToChatCapabilities,
): AddSourceId {
  const remembered = ADD_SOURCE_ORDER.find((source) => source === lastSource);
  // The camera is an action, not a pane, so it is never a landing place.
  if (
    remembered &&
    remembered !== 'camera' &&
    sourceServesIntent(remembered, intent, capabilities)
  ) {
    return remembered;
  }
  return 'device';
}

/**
 * What can be done with a selection of OneDrive / SharePoint files.
 *
 * @param fileNames - Names of the selected files.
 * @param capabilities - What this person can add from.
 * @returns The intents that fit EVERY selected file, in display order; empty
 *   when nothing is selected.
 */
export function intentsForSelection(
  fileNames: readonly string[],
  capabilities: AddToChatCapabilities,
): AddIntent[] {
  if (fileNames.length === 0) return [];
  const fits: Record<AddIntent, boolean> = {
    attach: capabilities.m365Files,
    // Document translation takes one document at a time.
    translate:
      capabilities.m365Translation &&
      fileNames.length === 1 &&
      isTranslatableName(fileNames[0]),
    transcribe: capabilities.m365Files && fileNames.every(isTranscribableName),
  };
  return ADD_INTENT_ORDER.filter((intent) => fits[intent]);
}

/**
 * The intent to act on for a selection: the wanted one when it fits,
 * otherwise the first that does.
 *
 * @param wanted - The intent currently chosen.
 * @param fileNames - Names of the selected files.
 * @param capabilities - What this person can add from.
 * @returns The intent to use, or null when nothing fits the selection.
 */
export function effectiveIntent(
  wanted: AddIntent,
  fileNames: readonly string[],
  capabilities: AddToChatCapabilities,
): AddIntent | null {
  const fitting = intentsForSelection(fileNames, capabilities);
  if (fitting.includes(wanted)) return wanted;
  return fitting[0] ?? null;
}

/**
 * The file extensions a picker should accept for an intent.
 *
 * @param intent - What will happen to the chosen files.
 * @returns Lowercase extensions without the dot, or undefined for "any".
 */
export function acceptedExtensions(
  intent: AddIntent,
): readonly string[] | undefined {
  if (intent === 'translate') return TRANSLATABLE_EXTENSIONS;
  if (intent === 'transcribe') return TRANSCRIBABLE_EXTENSIONS;
  return undefined;
}

/**
 * Narrows files dropped or pasted into the picker to the ones the intent can
 * take. The system file dialog filters by itself; a drop does not.
 *
 * @param files - Files as dropped or pasted.
 * @param intent - What will happen to them.
 * @returns The usable files: all of them when attaching, the audio/video
 *   ones when transcribing, and at most one document when translating.
 */
export function filesForIntent(
  files: readonly File[],
  intent: AddIntent,
): File[] {
  if (intent === 'transcribe') {
    return files.filter(
      (file) =>
        file.type.startsWith('audio/') ||
        file.type.startsWith('video/') ||
        isTranscribableName(file.name),
    );
  }
  if (intent === 'translate') {
    return files.filter((file) => isTranslatableName(file.name)).slice(0, 1);
  }
  return [...files];
}

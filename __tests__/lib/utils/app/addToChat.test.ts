import {
  AddToChatCapabilities,
  TRANSCRIBABLE_EXTENSIONS,
  TRANSLATABLE_EXTENSIONS,
  acceptedExtensions,
  effectiveIntent,
  filesForIntent,
  initialSource,
  intentsForSelection,
  isTranscribableName,
  isTranslatableName,
  needsPicker,
  sourceServesIntent,
  visibleSources,
} from '@/lib/utils/app/addToChat';

import { TRANSCRIPTION_ACCEPT_TYPES } from '@/lib/constants/fileTypes';
import { describe, expect, it } from 'vitest';

const NOTHING: AddToChatCapabilities = {
  camera: false,
  m365Files: false,
  m365Mail: false,
  m365Meetings: false,
  m365Translation: false,
};

const EVERYTHING: AddToChatCapabilities = {
  camera: true,
  m365Files: true,
  m365Mail: true,
  m365Meetings: true,
  m365Translation: true,
};

const with_ = (
  overrides: Partial<AddToChatCapabilities>,
): AddToChatCapabilities => ({ ...NOTHING, ...overrides });

describe('addToChat — file kinds', () => {
  it('recognises translatable and transcribable names, case-insensitively', () => {
    expect(isTranslatableName('Report.DOCX')).toBe(true);
    expect(isTranslatableName('call.mp4')).toBe(false);
    expect(isTranscribableName('Call.MP4')).toBe(true);
    expect(isTranscribableName('report.docx')).toBe(false);
  });

  it('treats a name without an extension as neither', () => {
    expect(isTranslatableName('docx')).toBe(false);
    expect(isTranscribableName('.mp3')).toBe(false);
  });

  it('derives the transcribable set from the transcribe input, so they cannot drift', () => {
    const fromInput = TRANSCRIPTION_ACCEPT_TYPES.split(',').filter((entry) =>
      entry.startsWith('.'),
    );
    expect(TRANSCRIBABLE_EXTENSIONS).toHaveLength(fromInput.length);
    expect(TRANSCRIBABLE_EXTENSIONS).toContain('m4a');
    // No entry kept its dot or a MIME wildcard.
    expect(TRANSCRIBABLE_EXTENSIONS.some((ext) => /[./*]/.test(ext))).toBe(
      false,
    );
    expect(TRANSLATABLE_EXTENSIONS).toContain('pdf');
  });
});

describe('addToChat — sources', () => {
  it('lists only the device sources when Microsoft 365 is off', () => {
    expect(visibleSources(NOTHING)).toEqual(['device', 'link']);
    expect(visibleSources(with_({ camera: true }))).toEqual([
      'device',
      'link',
      'camera',
    ]);
  });

  it('adds each Microsoft 365 source on its own switch', () => {
    expect(visibleSources(with_({ m365Mail: true }))).toEqual([
      'device',
      'link',
      'mail',
    ]);
    expect(visibleSources(with_({ m365Meetings: true }))).toEqual([
      'device',
      'link',
      'meetings',
    ]);
    expect(visibleSources(EVERYTHING)).toEqual([
      'device',
      'link',
      'camera',
      'onedrive',
      'mail',
      'meetings',
    ]);
  });

  it('lists OneDrive when only translation from it is on', () => {
    const caps = with_({ m365Translation: true });
    expect(visibleSources(caps)).toContain('onedrive');
    expect(sourceServesIntent('onedrive', 'translate', caps)).toBe(true);
    expect(sourceServesIntent('onedrive', 'attach', caps)).toBe(false);
    expect(sourceServesIntent('onedrive', 'transcribe', caps)).toBe(false);
  });

  it('serves each intent only from the sources that can', () => {
    const serving = (intent: 'attach' | 'translate' | 'transcribe') =>
      visibleSources(EVERYTHING).filter((source) =>
        sourceServesIntent(source, intent, EVERYTHING),
      );
    expect(serving('attach')).toEqual([
      'device',
      'link',
      'camera',
      'onedrive',
      'mail',
      'meetings',
    ]);
    expect(serving('translate')).toEqual(['device', 'onedrive']);
    expect(serving('transcribe')).toEqual(['device', 'onedrive', 'meetings']);
  });
});

describe('addToChat — needsPicker', () => {
  it('is false for every intent without a Microsoft 365 source', () => {
    for (const intent of ['attach', 'translate', 'transcribe'] as const) {
      expect(needsPicker(intent, with_({ camera: true }))).toBe(false);
    }
  });

  it('turns on per intent, by the sources that serve it', () => {
    const mailOnly = with_({ m365Mail: true });
    expect(needsPicker('attach', mailOnly)).toBe(true);
    expect(needsPicker('translate', mailOnly)).toBe(false);
    expect(needsPicker('transcribe', mailOnly)).toBe(false);

    const translationOnly = with_({ m365Translation: true });
    expect(needsPicker('attach', translationOnly)).toBe(false);
    expect(needsPicker('translate', translationOnly)).toBe(true);

    const meetingsOnly = with_({ m365Meetings: true });
    expect(needsPicker('attach', meetingsOnly)).toBe(true);
    expect(needsPicker('transcribe', meetingsOnly)).toBe(true);
    expect(needsPicker('translate', meetingsOnly)).toBe(false);
  });
});

describe('addToChat — initialSource', () => {
  it('reopens on the remembered source when it still serves the intent', () => {
    expect(initialSource('onedrive', 'attach', EVERYTHING)).toBe('onedrive');
    expect(initialSource('mail', 'attach', EVERYTHING)).toBe('mail');
  });

  it('falls back to this device when the remembered source cannot serve it', () => {
    // Mail cannot be translated or transcribed.
    expect(initialSource('mail', 'translate', EVERYTHING)).toBe('device');
    // Switched off since last time.
    expect(initialSource('onedrive', 'attach', NOTHING)).toBe('device');
  });

  it('never lands on the camera, nothing, or an unknown value', () => {
    expect(initialSource('camera', 'attach', EVERYTHING)).toBe('device');
    expect(initialSource(null, 'attach', EVERYTHING)).toBe('device');
    expect(initialSource('dropbox', 'attach', EVERYTHING)).toBe('device');
  });
});

describe('addToChat — what a selection allows', () => {
  it('offers nothing for an empty selection', () => {
    expect(intentsForSelection([], EVERYTHING)).toEqual([]);
    expect(effectiveIntent('attach', [], EVERYTHING)).toBeNull();
  });

  it('offers translate for exactly one document, and not for two', () => {
    expect(intentsForSelection(['a.docx'], EVERYTHING)).toEqual([
      'attach',
      'translate',
    ]);
    expect(intentsForSelection(['a.docx', 'b.docx'], EVERYTHING)).toEqual([
      'attach',
    ]);
  });

  it('offers transcribe only when every file is audio or video', () => {
    expect(intentsForSelection(['a.mp4', 'b.m4a'], EVERYTHING)).toEqual([
      'attach',
      'transcribe',
    ]);
    expect(intentsForSelection(['a.mp4', 'b.docx'], EVERYTHING)).toEqual([
      'attach',
    ]);
  });

  it('withholds what the person has no access to', () => {
    expect(intentsForSelection(['a.docx'], with_({ m365Files: true }))).toEqual(
      ['attach'],
    );
    expect(
      intentsForSelection(['a.docx'], with_({ m365Translation: true })),
    ).toEqual(['translate']);
  });

  it('keeps the wanted intent while it fits and falls back when it does not', () => {
    expect(effectiveIntent('translate', ['a.docx'], EVERYTHING)).toBe(
      'translate',
    );
    expect(effectiveIntent('translate', ['a.docx', 'b.docx'], EVERYTHING)).toBe(
      'attach',
    );
    expect(effectiveIntent('transcribe', ['a.docx'], EVERYTHING)).toBe(
      'attach',
    );
    expect(
      effectiveIntent('attach', ['a.mp4'], with_({ m365Translation: true })),
    ).toBeNull();
  });
});

describe('addToChat — narrowing files to an intent', () => {
  const file = (name: string, type = '') => new File(['x'], name, { type });

  it('accepts any extension when attaching and a fixed set otherwise', () => {
    expect(acceptedExtensions('attach')).toBeUndefined();
    expect(acceptedExtensions('translate')).toBe(TRANSLATABLE_EXTENSIONS);
    expect(acceptedExtensions('transcribe')).toBe(TRANSCRIBABLE_EXTENSIONS);
  });

  it('keeps every file when attaching', () => {
    const files = [file('a.docx'), file('b.mp4'), file('c.png')];
    expect(filesForIntent(files, 'attach')).toEqual(files);
  });

  it('keeps audio and video when transcribing, by type or by name', () => {
    const byName = file('call.mkv');
    const byType = file('recording', 'audio/mpeg');
    const kept = filesForIntent([file('a.docx'), byName, byType], 'transcribe');
    expect(kept).toEqual([byName, byType]);
  });

  it('keeps one document when translating and none when there is none', () => {
    const first = file('a.docx');
    expect(
      filesForIntent([file('x.mp4'), first, file('b.pdf')], 'translate'),
    ).toEqual([first]);
    expect(filesForIntent([file('x.mp4')], 'translate')).toEqual([]);
  });
});

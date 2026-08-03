import {
  meetingTranscriptFilename,
  parseVttTranscript,
} from '@/lib/services/m365/meetingTranscript';

import { describe, expect, it } from 'vitest';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Ada Lovelace>We should ship the geo report Friday.</v>

00:00:04.500 --> 00:00:06.000
<v Ada Lovelace>Before the offsite.</v>

00:00:06.500 --> 00:00:09.000
<v Grace Hopper>Agreed. I'll draft the summary.</v>
`;

describe('parseVttTranscript', () => {
  it('produces speaker-attributed paragraphs, merging consecutive cues', () => {
    const result = parseVttTranscript(VTT);
    expect(result.text).toBe(
      "Ada Lovelace: We should ship the geo report Friday. Before the offsite.\n\nGrace Hopper: Agreed. I'll draft the summary.",
    );
    expect(result.speakers).toEqual(['Ada Lovelace', 'Grace Hopper']);
    expect(result.cueCount).toBe(3);
  });

  it('keeps spoken prose that merely contains "-->"', () => {
    // A bare /-->/ test treated this cue TEXT as a timing line and dropped
    // it (and mis-set the in-cue flag for what followed).
    const result = parseVttTranscript(`WEBVTT

00:00:01.000 --> 00:00:02.000
<v Ada Lovelace>The arrow --> points right.</v>

00:00:02.500 --> 00:00:03.000
<v Ada Lovelace>Second line survives.</v>
`);
    expect(result.text).toContain('The arrow --> points right.');
    expect(result.text).toContain('Second line survives.');
    expect(result.cueCount).toBe(2);
  });

  it('handles cues without voice spans', () => {
    const plain = `WEBVTT

00:00:01.000 --> 00:00:02.000
Recording started
`;
    const result = parseVttTranscript(plain);
    expect(result.text).toBe('Recording started');
    expect(result.speakers).toEqual([]);
  });

  it('strips inline tags and ignores header/blank lines', () => {
    const styled = `WEBVTT

00:00:01.000 --> 00:00:02.000
<v Bob><b>Bold</b> point</v>
`;
    expect(parseVttTranscript(styled).text).toBe('Bob: Bold point');
  });

  it('returns empty text for an empty or headers-only file', () => {
    expect(parseVttTranscript('WEBVTT\n\n').text).toBe('');
  });
});

describe('meetingTranscriptFilename', () => {
  it('combines subject and date, sanitized', () => {
    expect(
      meetingTranscriptFilename('Q3: plan / review', '2026-07-30T09:00:00Z'),
    ).toBe('Q3- plan - review (2026-07-30) transcript.txt');
  });

  it('falls back when subject is missing', () => {
    expect(meetingTranscriptFilename(undefined, undefined)).toBe(
      'Meeting transcript.txt',
    );
  });
});

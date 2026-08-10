/**
 * Teams meeting transcript (WebVTT) → speaker-attributed plain text.
 *
 * Graph returns transcripts as VTT with voice spans:
 *   00:00:03.120 --> 00:00:06.000
 *   <v Ada Lovelace>We should ship the geo report Friday.</v>
 *
 * The output collapses consecutive cues from the same speaker into one
 * paragraph — "Name: text" lines — which is what the app's transcript shape
 * (TranscriptViewer, summarization prompts) expects. Cue timing metadata is
 * dropped; meeting Q&A cares about who said what, not millisecond offsets.
 */
import { htmlToPlainTextFragment } from '@/lib/utils/shared/html/stripTags';

const VOICE_SPAN_REGEX = /<v(?:\.[^ >]*)?\s+([^>]*)>([\s\S]*?)<\/v>/g;
/**
 * A WebVTT cue-timing line: `00:00:03.120 --> 00:00:06.000` (hours
 * optional, trailing cue settings allowed). Deliberately precise rather
 * than a bare `-->` test: prose is spoken in these meetings, and a cue
 * whose TEXT contains "-->" ("the arrow --> points right") was previously
 * mistaken for a timing line and dropped. Being specific also stops
 * CodeQL's js/bad-tag-filter heuristic reading a bare `-->` as a
 * half-written HTML-comment filter.
 */
const TIMING_LINE_REGEX =
  /^\s*(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}/;

function stripTags(text: string): string {
  return htmlToPlainTextFragment(text).trim();
}

export interface MeetingTranscriptResult {
  /** "Speaker: text" paragraphs, blank-line separated. */
  text: string;
  /** Distinct speaker display names, in order of first appearance. */
  speakers: string[];
  cueCount: number;
}

export function parseVttTranscript(vtt: string): MeetingTranscriptResult {
  const lines = vtt.split(/\r?\n/);
  const cues: { speaker: string; text: string }[] = [];
  const speakers: string[] = [];

  let inCue = false;
  for (const line of lines) {
    if (TIMING_LINE_REGEX.test(line)) {
      inCue = true;
      continue;
    }
    if (!inCue) continue;
    if (!line.trim()) {
      inCue = false;
      continue;
    }
    VOICE_SPAN_REGEX.lastIndex = 0;
    let matched = false;
    let match: RegExpExecArray | null;
    while ((match = VOICE_SPAN_REGEX.exec(line)) !== null) {
      matched = true;
      const speaker = match[1].trim() || 'Speaker';
      const text = stripTags(match[2]);
      if (!text) continue;
      if (!speakers.includes(speaker)) speakers.push(speaker);
      cues.push({ speaker, text });
    }
    if (!matched) {
      const text = stripTags(line);
      if (text) cues.push({ speaker: '', text });
    }
  }

  // Merge consecutive same-speaker cues into single paragraphs.
  const paragraphs: string[] = [];
  let currentSpeaker: string | null = null;
  let currentParts: string[] = [];
  const flush = () => {
    if (currentParts.length === 0) return;
    const body = currentParts.join(' ');
    paragraphs.push(currentSpeaker ? `${currentSpeaker}: ${body}` : body);
    currentParts = [];
  };
  for (const cue of cues) {
    if (cue.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = cue.speaker;
    }
    currentParts.push(cue.text);
  }
  flush();

  return { text: paragraphs.join('\n\n'), speakers, cueCount: cues.length };
}

/** "Weekly sync" + 2026-07-30 → "Weekly sync (2026-07-30) transcript.txt" */
export function meetingTranscriptFilename(
  subject: string | undefined,
  startIso: string | undefined,
): string {
  const cleaned = (subject ?? 'Meeting')
    .replace(/[\\/:*?"<>|#%]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const day = startIso ? startIso.slice(0, 10) : '';
  return `${cleaned || 'Meeting'}${day ? ` (${day})` : ''} transcript.txt`;
}

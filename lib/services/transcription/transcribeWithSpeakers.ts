import { env } from '@/config/environment';
import fs from 'fs';
import { basename, extname } from 'path';

const AZURE_LOCALES: Record<string, string> = {
  af: 'af-ZA',
  ar: 'ar-SA',
  hy: 'hy-AM',
  az: 'az-AZ',
  be: 'be-BY',
  bs: 'bs-BA',
  bg: 'bg-BG',
  ca: 'ca-ES',
  zh: 'zh-CN',
  hr: 'hr-HR',
  cs: 'cs-CZ',
  da: 'da-DK',
  nl: 'nl-NL',
  en: 'en-US',
  et: 'et-EE',
  fi: 'fi-FI',
  fr: 'fr-FR',
  gl: 'gl-ES',
  de: 'de-DE',
  el: 'el-GR',
  he: 'he-IL',
  hi: 'hi-IN',
  hu: 'hu-HU',
  is: 'is-IS',
  id: 'id-ID',
  it: 'it-IT',
  ja: 'ja-JP',
  kn: 'kn-IN',
  kk: 'kk-KZ',
  ko: 'ko-KR',
  lv: 'lv-LV',
  lt: 'lt-LT',
  mk: 'mk-MK',
  ms: 'ms-MY',
  mi: 'mi-NZ',
  mr: 'mr-IN',
  ne: 'ne-NP',
  no: 'nb-NO',
  fa: 'fa-IR',
  pl: 'pl-PL',
  pt: 'pt-BR',
  ro: 'ro-RO',
  ru: 'ru-RU',
  sr: 'sr-RS',
  sk: 'sk-SK',
  sl: 'sl-SI',
  es: 'es-ES',
  sw: 'sw-KE',
  sv: 'sv-SE',
  tl: 'fil-PH',
  ta: 'ta-IN',
  th: 'th-TH',
  tr: 'tr-TR',
  uk: 'uk-UA',
  ur: 'ur-PK',
  vi: 'vi-VN',
  cy: 'cy-GB',
  my: 'my-MM',
};

function audioContentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.mp3':
    case '.mpga':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.mp4':
      return 'video/mp4';
    case '.wav':
      return 'audio/wav';
    case '.webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

interface SpeechPhrase {
  speaker?: number | string | null;
  offsetMilliseconds?: number;
  text?: string;
}

/** Transcribes a local audio file and groups adjacent phrases by speaker. */
export async function transcribeWithSpeakers(
  filePath: string,
  language?: string,
): Promise<string> {
  const { SPEECH_KEY, SPEECH_REGION } = env;
  if (!SPEECH_KEY || !SPEECH_REGION) {
    throw new Error('Speaker-separated transcription is not configured.');
  }

  const locale = language
    ? AZURE_LOCALES[language.toLowerCase().split('-')[0]]
    : undefined;
  if (language && !locale) {
    throw new Error(`Unsupported transcription language: ${language}`);
  }

  const definition: {
    locales?: string[];
    diarization: { enabled: true; maxSpeakers: 4 };
  } = {
    ...(locale ? { locales: [locale] } : {}),
    diarization: { enabled: true, maxSpeakers: 4 },
  };
  const formData = new FormData();
  const audio = await fs.promises.readFile(filePath);
  formData.append(
    'audio',
    new Blob([Uint8Array.from(audio)], { type: audioContentType(filePath) }),
    basename(filePath),
  );
  formData.append('definition', JSON.stringify(definition));

  const response = await fetch(
    `https://${SPEECH_REGION}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`,
    {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': SPEECH_KEY },
      body: formData,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Azure Speech transcription failed (${response.status}): ${await response.text()}`,
    );
  }

  const result = (await response.json()) as { phrases?: SpeechPhrase[] };
  if (!Array.isArray(result.phrases)) {
    throw new Error('Azure Speech response did not contain phrases.');
  }

  const lines: Array<{ speaker: string; timestamp: string; text: string }> = [];
  for (const phrase of result.phrases) {
    const text = phrase.text?.trim();
    if (!text) continue;

    const speakerNumber = Number(phrase.speaker);
    const speaker = Number.isFinite(speakerNumber)
      ? `Speaker ${speakerNumber + 1}`
      : `Speaker ${String(phrase.speaker || '1').replace(/^speaker\s*/i, '')}`;
    const seconds = Math.floor((phrase.offsetMilliseconds || 0) / 1000);
    const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
    const remainingSeconds = String(seconds % 60).padStart(2, '0');
    const timestamp = `[${minutes}:${remainingSeconds}]`;
    const previous = lines[lines.length - 1];

    if (previous?.speaker === speaker) {
      previous.text += ` ${text}`;
    } else {
      lines.push({ speaker, timestamp, text });
    }
  }

  return lines
    .map(({ speaker, timestamp, text }) => `${timestamp} ${speaker}: ${text}`)
    .join('\n');
}

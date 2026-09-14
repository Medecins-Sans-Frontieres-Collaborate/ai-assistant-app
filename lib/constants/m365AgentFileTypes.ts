/**
 * File types an M365 agent source can make use of — shared between the
 * admin editor's picker filter (client) and the planner's classification
 * (server), so the picker never offers a file the index run would only
 * report as "skipped".
 *
 * Two tiers, mirroring `agentSourcePlanner.classifyItem`:
 * - indexable: extracted directly (`documentSignature.INDEXABLE_EXTENSIONS`)
 * - preparable: images / audio / video the per-file Prepare action turns
 *   into text (vision description, transcript, OCR)
 */
import { INDEXABLE_EXTENSIONS } from '@/lib/services/m365/documentSignature';

import { AUDIO_VIDEO_EXTENSIONS } from '@/lib/constants/fileTypes';

/** Image formats a vision model can be handed (svg is markup, not pixels). */
export const PREPARABLE_IMAGE_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'heic',
];

/** Extensions (lowercase, no dot) the agent source picker accepts. */
export const M365_AGENT_ACCEPT_EXTENSIONS: string[] = Array.from(
  new Set([
    ...INDEXABLE_EXTENSIONS,
    ...PREPARABLE_IMAGE_EXTENSIONS,
    ...AUDIO_VIDEO_EXTENSIONS.map((ext) => ext.replace(/^\./, '')),
  ]),
);

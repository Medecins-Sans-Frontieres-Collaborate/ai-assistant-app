/**
 * The document sources every feature contributes (THE DOCUMENT SOURCE),
 * registered with the documents layer in one place. Routes that read a
 * source call {@link ensureDocumentSources} first; the documents layer
 * itself never imports a feature.
 */
import {
  translationOriginalSource,
  translationOutputSource,
} from '@/lib/services/documentTranslation/translationOutputs';
import { registerDocumentSource } from '@/lib/services/documents/sources/documentSources';

let registered = false;

/** Registers every feature's source kinds, once per process. */
export function ensureDocumentSources(): void {
  if (registered) return;
  registerDocumentSource(translationOutputSource);
  registerDocumentSource(translationOriginalSource);
  registered = true;
}

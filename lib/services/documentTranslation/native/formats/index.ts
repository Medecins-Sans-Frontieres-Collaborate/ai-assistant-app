/**
 * The adapter for each source format (see THE FORMAT ADAPTER).
 */
import {
  NativeSourceFormat,
  isNativeDeckFormat,
} from '@/lib/utils/shared/translation/nativeFormats';

import { deckFormat } from './deckFormat';
import { NativeFormatAdapter } from './nativeFormat';
import { pdfFormat } from './pdfFormat';

/**
 * The adapter that reads and rebuilds files of a format.
 *
 * @param format - A run's source format.
 * @throws Error for a format no adapter handles.
 */
export function nativeFormatAdapter(
  format: NativeSourceFormat,
): NativeFormatAdapter {
  if (format === 'pdf') return pdfFormat;
  if (isNativeDeckFormat(format)) return deckFormat(format);
  throw new Error(`No adapter translates .${String(format)} files`);
}

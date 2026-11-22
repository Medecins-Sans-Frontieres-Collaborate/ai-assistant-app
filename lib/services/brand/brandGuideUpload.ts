/**
 * A brand guide's upload (docs/DOCUMENT_PLATFORM.md, phase E). A guide is a
 * designed PDF, often several times the size the general upload route
 * takes, so an admin sends it here as its own bytes: read with a bound,
 * checked to be a PDF, and kept as one of the admin's uploads so drafting
 * and saving take it like any other brand file (THE BRAND FILE CONVENTION).
 */
import { Session } from 'next-auth';

import { readBoundedBody } from '@/lib/services/backup/server/routeHelpers';
import { storeUploadedFile } from '@/lib/services/documents/sources/documentSources';

import { BRAND_FILE_MAX_BYTES } from '@/lib/utils/shared/brand/brandBook';

import {
  BRAND_FILE_CONTENT_TYPES,
  BrandFileError,
  brandFileTooLarge,
} from './brandBooks';

/** How every PDF begins; a guide that does not is refused unread. */
const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');

/**
 * Keeps a brand guide the admin sent as one of their uploads.
 *
 * @param request - The request whose body is the PDF's bytes. One that
 *   declares or sends more than a guide may hold is refused without being
 *   read to the end.
 * @returns Its reference (`/api/file/<sha256>.pdf`) and size.
 * @throws BrandFileError when it is empty, too large, or not a PDF.
 */
export async function storeBrandGuideUpload(
  session: Session,
  request: Request,
): Promise<{ file: string; bytes: number }> {
  const data = await readBoundedBody(request, BRAND_FILE_MAX_BYTES.source);
  if (data === null) throw brandFileTooLarge('source');
  if (data.length === 0) throw new BrandFileError('The brand guide is empty.');
  if (!data.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    throw new BrandFileError('A brand guide must be a PDF.');
  }
  const file = await storeUploadedFile(
    session,
    data,
    'pdf',
    BRAND_FILE_CONTENT_TYPES.pdf,
  );
  return { file, bytes: data.length };
}

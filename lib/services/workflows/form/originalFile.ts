import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  readFormTemplate,
} from '@/lib/services/agentAccess/accessRulesStore';
import { downloadBlob } from '@/lib/services/agentAccess/blobCas';
import {
  FORM_TEMPLATE_ID_PATTERN,
  FORM_TEMPLATE_SOURCE,
  formTemplateOriginalBlobPath,
} from '@/lib/services/agentAccess/types';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty } from '@/lib/utils/server/blob/blob';

/**
 * Server-side access to a template's original upload.
 *
 * Two reference shapes:
 *  - `/api/file/{sha256}.{docx|pdf}` — the caller's own upload, read only
 *    from their `{userId}/uploads/files/` namespace (ownership is the path,
 *    exactly as the photo route treats image refs).
 *  - `admin:{formtpl-id}.{docx|pdf}` — an admin template's original in the
 *    admin container. Readable only when the caller may use that template:
 *    the same access rule the template listing applies, evaluated here so a
 *    crafted snapshot cannot turn the render route into a file oracle.
 */

const FILE_REF = /^\/api\/file\/([a-f0-9]{64})\.(docx|pdf)$/i;
const ADMIN_REF = /^admin:(formtpl-[a-f0-9]{12})\.(docx|pdf)$/i;

export const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

export type OriginalRef =
  | { kind: 'user'; blobName: string; ext: 'docx' | 'pdf' }
  | { kind: 'admin'; templateId: string; ext: 'docx' | 'pdf' };

export function parseOriginalRef(fileId: string): OriginalRef | null {
  const user = fileId.match(FILE_REF);
  if (user) {
    return {
      kind: 'user',
      blobName: `${user[1]}.${user[2].toLowerCase()}`,
      ext: user[2].toLowerCase() as 'docx' | 'pdf',
    };
  }
  const admin = fileId.match(ADMIN_REF);
  if (admin && FORM_TEMPLATE_ID_PATTERN.test(admin[1])) {
    return {
      kind: 'admin',
      templateId: admin[1],
      ext: admin[2].toLowerCase() as 'docx' | 'pdf',
    };
  }
  return null;
}

export function adminOriginalRef(id: string, ext: 'docx' | 'pdf'): string {
  return `admin:${id}.${ext}`;
}

async function readUserOriginal(
  session: Session,
  blobName: string,
): Promise<Uint8Array> {
  const userId = getUserIdFromSession(session);
  const storage = createBlobStorageClient(session);
  const path = `${userId}/uploads/files/${blobName}`;
  const size = await storage.getBlobSize(path);
  if (size > MAX_ORIGINAL_BYTES) throw new Error('Original file is too large');
  const buffer = (await storage.get(path, BlobProperty.BLOB)) as Buffer;
  return new Uint8Array(buffer);
}

/** Reads an admin original; the caller must have checked access. */
export async function readAdminOriginalBytes(
  templateId: string,
  ext: 'docx' | 'pdf',
): Promise<Uint8Array | null> {
  const storage = createAgentAccessBlobStorage();
  const result = await downloadBlob(
    storage,
    formTemplateOriginalBlobPath(templateId, ext),
    'formTemplateOriginal',
  );
  if (result === null) return null;
  if (result.buffer.length > MAX_ORIGINAL_BYTES) {
    throw new Error('Original file is too large');
  }
  return new Uint8Array(result.buffer);
}

/** Stores an original next to an admin template (binary, overwrite). */
export async function writeAdminOriginalBytes(
  templateId: string,
  ext: 'docx' | 'pdf',
  bytes: Uint8Array,
): Promise<void> {
  const storage = createAgentAccessBlobStorage();
  await storage
    .getBlockBlobClient(formTemplateOriginalBlobPath(templateId, ext))
    .uploadData(Buffer.from(bytes), {
      blobHTTPHeaders: {
        blobContentType:
          ext === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    });
}

export async function deleteAdminOriginal(
  templateId: string,
  ext: 'docx' | 'pdf',
): Promise<void> {
  const storage = createAgentAccessBlobStorage();
  await storage.deleteIfExists(formTemplateOriginalBlobPath(templateId, ext));
}

/** Removes every original a template may have had (an ext change leaves two). */
export async function deleteAdminOriginals(templateId: string): Promise<void> {
  await Promise.all(
    (['docx', 'pdf'] as const).map((ext) =>
      deleteAdminOriginal(templateId, ext),
    ),
  );
}

/**
 * Whether the caller may use an admin template (the listing's rule) AND the
 * template still exists — an orphaned original behind a deleted record is
 * not a template anyone may use, whatever the (possibly gone) rule says.
 * Group warm-up needs the request; without one only user/domain rules apply.
 */
export async function canUseAdminTemplate(
  session: Session,
  templateId: string,
  req?: NextRequest,
): Promise<boolean> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return false;
  if (req) await resolveUserGroupIds(req, session);
  await service.ensureFresh();
  const allowed =
    service.evaluateAccess({
      userMail: session.user.mail ?? undefined,
      source: FORM_TEMPLATE_SOURCE,
      agentName: templateId,
    }).decision === 'allow';
  if (!allowed) return false;
  const stored = await readFormTemplate(
    createAgentAccessBlobStorage(),
    templateId,
  );
  return stored !== null;
}

export async function readOriginalFile(
  session: Session,
  fileId: string,
  req?: NextRequest,
): Promise<{ bytes: Uint8Array; ext: 'docx' | 'pdf' }> {
  const ref = parseOriginalRef(fileId);
  if (!ref) throw new Error('Invalid file reference');
  if (ref.kind === 'user') {
    return {
      bytes: await readUserOriginal(session, ref.blobName),
      ext: ref.ext,
    };
  }
  if (!(await canUseAdminTemplate(session, ref.templateId, req))) {
    // Same answer as a missing file: no existence oracle for restricted
    // templates.
    throw new Error('Original file not found');
  }
  const bytes = await readAdminOriginalBytes(ref.templateId, ref.ext);
  if (!bytes) throw new Error('Original file not found');
  return { bytes, ext: ref.ext };
}

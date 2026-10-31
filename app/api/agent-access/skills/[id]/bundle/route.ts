import { NextRequest, NextResponse } from 'next/server';

import { serializeSkillBundle } from '@/lib/services/skills/skillBundle';
import { authorizeSkillDocuments } from '@/lib/services/skills/skillDocumentAuth';
import { readSkillOriginal } from '@/lib/services/skills/skillDocumentStore';
import { skillResourcePath } from '@/lib/services/skills/skillFiles';

import { handleApiError } from '@/lib/utils/server/api/apiResponse';

/** Exports original resources and SKILL.md, never derived chunks or index metadata. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const authorized = await authorizeSkillDocuments(id);
    if (authorized.response) return authorized.response;
    const resources = [];
    for (const document of authorized.skill.documents) {
      const bytes = await readSkillOriginal(
        authorized.storage,
        id,
        document.fileId,
        request.signal,
      );
      if (!bytes)
        throw new Error(
          `Missing resource ${document.filename}; export cannot be completed`,
        );
      resources.push({
        path: document.resourcePath ?? skillResourcePath(document.filename),
        bytes: new Uint8Array(bytes),
      });
    }
    const bundle = serializeSkillBundle(authorized.skill, resources);
    return new NextResponse(new Uint8Array(bundle), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${id}.zip"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return handleApiError(error, 'Could not export skill bundle');
  }
}

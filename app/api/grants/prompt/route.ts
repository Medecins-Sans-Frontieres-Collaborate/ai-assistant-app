import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { canAccessGrants } from '@/lib/services/grants/access';
import { loadOCConfig, resolveOC } from '@/lib/services/grants/ocConfig';
import {
  deletePromptOverride,
  loadPromptOverride,
  savePromptOverride,
} from '@/lib/services/grants/promptStore';
import { buildExtractionPrompt } from '@/lib/services/grants/prompts/extractionPrompt';

import { auth } from '@/auth';

// Guard against absurd payloads; the default prompt is ~22 KB.
const MAX_PROMPT_LENGTH = 200_000;

interface PromptPutBody {
  oc?: string;
  prompt?: string;
}

function currentYear(): number {
  return new Date().getFullYear();
}

/**
 * GET /api/grants/prompt?oc=OCA[&year=2026]
 * Returns the effective prompt for an OC: the saved override if one exists,
 * otherwise the freshly-rendered code default.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessGrants(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const oc = resolveOC(request.nextUrl.searchParams.get('oc'));
    if (!oc) {
      return NextResponse.json(
        { error: 'Missing or unknown query parameter: oc' },
        { status: 400 },
      );
    }
    const ocCfg = loadOCConfig(oc);

    const yearParam = request.nextUrl.searchParams.get('year');
    const year = yearParam ? Number(yearParam) : currentYear();

    const storage = createBlobStorageClient(session);
    const saved = await loadPromptOverride(storage, oc);

    if (saved) {
      return NextResponse.json({
        oc,
        prompt: saved.prompt,
        isOverride: true,
        updatedBy: saved.updatedBy,
        updatedAt: saved.updatedAt,
      });
    }

    return NextResponse.json({
      oc,
      prompt: buildExtractionPrompt(ocCfg, year),
      isOverride: false,
      updatedBy: null,
      updatedAt: null,
    });
  } catch (error) {
    console.error('Error loading grant prompt:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/grants/prompt  { oc, prompt }
 * Saves a per-OC prompt override (shared across users).
 */
export async function PUT(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessGrants(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body: PromptPutBody = await request.json();
    const oc = resolveOC(body.oc);
    const prompt = body.prompt;

    if (!oc || typeof prompt !== 'string') {
      return NextResponse.json(
        { error: 'Missing required fields: oc and prompt' },
        { status: 400 },
      );
    }
    if (!prompt.trim()) {
      return NextResponse.json(
        { error: 'Prompt cannot be empty' },
        { status: 400 },
      );
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return NextResponse.json(
        { error: `Prompt exceeds ${MAX_PROMPT_LENGTH} characters` },
        { status: 400 },
      );
    }

    const updatedBy =
      session.user.mail ||
      session.user.displayName ||
      session.user.id ||
      'unknown';
    const storage = createBlobStorageClient(session);
    const record = await savePromptOverride(storage, oc, prompt, updatedBy);

    return NextResponse.json({
      oc,
      isOverride: true,
      updatedBy: record.updatedBy,
      updatedAt: record.updatedAt,
    });
  } catch (error) {
    console.error('Error saving grant prompt:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/grants/prompt?oc=OCA
 * Removes the saved override, resetting the OC to the code default.
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessGrants(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const oc = resolveOC(request.nextUrl.searchParams.get('oc'));
    if (!oc) {
      return NextResponse.json(
        { error: 'Missing or unknown query parameter: oc' },
        { status: 400 },
      );
    }

    const storage = createBlobStorageClient(session);
    await deletePromptOverride(storage, oc);

    return NextResponse.json({ oc, isOverride: false });
  } catch (error) {
    console.error('Error resetting grant prompt:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

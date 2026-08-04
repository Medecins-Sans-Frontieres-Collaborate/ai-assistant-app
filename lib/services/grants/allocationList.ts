/**
 * Allocation-list loading, shared by every OC.
 *
 * An allocation list is the stakeholder-maintained roster of project codes that
 * are *expected* to appear in a given OC's narratives. The coverage check
 * reconciles it against what we actually extracted, so a missing or unreadable
 * list silently downgrades that screen to "no allocation list found".
 *
 * There is deliberately no per-OC logic here. Every OC uses the same file
 * shape, so the spec is derived from the OC name and an OC only needs an
 * `allocation_list` block in its JSON config when it deviates — for example a
 * different filename, a header that does not start on the first row, or column
 * names the resolver cannot recognize.
 */
import {
  type OCConfig,
  type SupplementalFileSpec,
} from '@/lib/services/grants/ocConfig';
import { type ExpectedProject } from '@/lib/services/grants/preprocess';
import {
  loadTable,
  resolveColumn,
} from '@/lib/services/grants/supplementalTable';

import { BlobProperty } from '@/lib/utils/server/blob/blob';

import { safeChildName, safeJoin } from './runPaths';

import { writeFile } from 'fs/promises';
import { basename, join } from 'path';

/**
 * Accepted header wordings per column, most-preferred first.
 *
 */
export const ALLOCATION_COLUMN_ALIASES = {
  code: ['project code', 'project codes', 'code', 'codes', 'project number'],
  name: ['project name', 'project names', 'name', 'names', 'project title'],
  country: ['country', 'countries', 'mission country'],
} as const;

/**
 * The allocation-list spec for an OC: its own config block when present,
 * otherwise the convention every OC follows.
 */
export function allocationSpecFor(config: OCConfig): SupplementalFileSpec {
  return (
    config.supplemental_files?.allocation_list ?? {
      filename: `${config.name}-Allocation-List.csv`,
      skiprows: 0,
      columns: {
        code: 'Project Code',
        name: 'Project Name',
        country: 'Country',
      },
    }
  );
}

export interface AllocationBlobInfo {
  name: string;
  lastModified?: Date;
}

/**
 * Pick the allocation list out of an OC's supplemental blobs.
 */
export function matchAllocationBlob(
  blobs: AllocationBlobInfo[],
  configFilename: string,
): string | null {
  const target = configFilename.toLowerCase();
  const specificity = (b: AllocationBlobInfo): number => {
    const n = basename(b.name).toLowerCase();
    if (n === target) return 3;
    if (n.includes(target)) return 2;
    if (n.includes('allocation')) return 1;
    return 0;
  };
  const candidates = blobs.filter((b) => specificity(b) > 0);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const byTime =
      (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0);
    if (byTime !== 0) return byTime;
    return specificity(b) - specificity(a);
  });
  if (candidates.length > 1) {
    console.log(
      `[grants] Multiple allocation-list candidates; picking newest "${basename(candidates[0].name)}" ` +
        `over ${candidates
          .slice(1)
          .map((c) => `"${basename(c.name)}"`)
          .join(', ')}.`,
    );
  }
  return candidates[0].name;
}

/**
 * Load the expected (code, name, country) roster for an OC from its
 * supplemental blob folder. Returns an empty list — never throws — when no
 * allocation list is present or its project-code column is unrecognizable, so
 * the coverage check degrades to code-detection-only rather than failing.
 */
export async function loadExpectedProjects(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blobClient: any;
  oc: string;
  config: OCConfig;
  workDir: string;
}): Promise<ExpectedProject[]> {
  const { blobClient, oc, config, workDir } = params;
  const spec = allocationSpecFor(config);

  let blobs: AllocationBlobInfo[] = [];
  try {
    blobs = await blobClient.listBlobsDetailed(`grants/${oc}/supplemental/`);
  } catch (err) {
    // A listing failure (network, TLS interception, auth) is NOT the same as
    // "no allocation list uploaded" — log loudly so the empty coverage banner
    // is never diagnosed as a missing or misformatted file.
    console.error(
      `[grants] ${oc}: FAILED to list grants/${oc}/supplemental/ — coverage will ` +
        `report "no allocation list" but the real cause is a storage error:`,
      JSON.stringify(err instanceof Error ? err.message : String(err)),
    );
    return [];
  }

  const blobPath = matchAllocationBlob(blobs, spec.filename);
  if (!blobPath) {
    console.log(
      `[grants] ${oc}: no allocation list found in grants/${oc}/supplemental/ ` +
        `(looked for "${spec.filename}" or any file named "*allocation*").`,
    );
    return [];
  }

  const localPath = safeJoin(workDir, safeChildName(blobPath));
  const buffer = (await blobClient.get(blobPath, BlobProperty.BLOB)) as Buffer;
  await writeFile(localPath, buffer);

  const rows = loadTable(localPath, spec.skiprows || 0);
  const headers = Object.keys(rows[0] ?? {});

  const codeCol = resolveColumn(
    headers,
    String(spec.columns.code || 'Project Code'),
    [...ALLOCATION_COLUMN_ALIASES.code],
  );
  const nameCol = resolveColumn(
    headers,
    String(spec.columns.name || 'Project Name'),
    [...ALLOCATION_COLUMN_ALIASES.name],
  );
  const countryCol = resolveColumn(
    headers,
    String(spec.columns.country || 'Country'),
    [...ALLOCATION_COLUMN_ALIASES.country],
  );

  if (!codeCol) {
    console.warn(
      `[grants] ${oc}: allocation list ${JSON.stringify(basename(blobPath))} has no recognizable ` +
        `project-code column. Expected "${spec.columns.code}"; header row reads: ` +
        `${JSON.stringify(headers.join(', ') || '(empty)')}`,
    );
    return [];
  }
  console.log(
    `[grants] ${oc}: allocation list ${JSON.stringify(basename(blobPath))} columns → ` +
      `code: ${JSON.stringify(codeCol)}, name: ${JSON.stringify(nameCol ?? '(none)')}, country: ${JSON.stringify(countryCol ?? '(none)')}`,
  );

  const out: ExpectedProject[] = [];
  for (const r of rows) {
    const code = String(r[codeCol] ?? '').trim();
    const name = nameCol ? String(r[nameCol] ?? '').trim() : '';
    const country = countryCol ? String(r[countryCol] ?? '').trim() : '';
    if (code && code.toUpperCase() !== 'NAN') out.push({ code, name, country });
  }
  console.log(
    `[grants] ${oc}: loaded ${out.length} expected project(s) from allocation list.`,
  );
  return out;
}

// Per-OC configurations.
import ocaConfig from './oc-configs/oca.json';
import ocbConfig from './oc-configs/ocb.json';
import ocbaConfig from './oc-configs/ocba.json';
import ocgConfig from './oc-configs/ocg.json';
import ocpConfig from './oc-configs/ocp.json';
import wacaConfig from './oc-configs/waca.json';

// Raw parsed configs keyed by lowercase OC name. Typed loosely because each JSON
// file only populates the fields that OC needs; loadOCConfig supplies defaults
// for the rest.
const RAW_CONFIGS: Record<string, Record<string, unknown>> = {
  oca: ocaConfig,
  ocb: ocbConfig,
  ocba: ocbaConfig,
  ocg: ocgConfig,
  ocp: ocpConfig,
  waca: wacaConfig,
};

/** Canonical OC display names, e.g. 'OCA', 'WaCA'. */
export const OC_NAMES: readonly string[] = Object.values(RAW_CONFIGS).map(
  (c) => c.name as string,
);

/**
 * Resolve a client-supplied OC name (any case) to its canonical name, or null
 * if unknown. The returned string is the config's own name, which is also
 * the exact casing used for blob-path segments (grants/<name>/...), so read
 * and write paths agree. Matching is case-insensitive, the returned value is not.
 */
export function resolveOC(ocName: unknown): string | null {
  if (typeof ocName !== 'string') return null;
  const cfg = RAW_CONFIGS[ocName.toLowerCase()];
  return cfg ? (cfg.name as string) : null;
}

export interface SupplementalFileSpec {
  filename: string;
  skiprows?: number;
  encoding?: string;
  format?: string;
  partner_section?: string;
  columns: Record<string, string | number>;
}

export interface OCConfig {
  name: string;
  code_regex: string;
  code_prefix: string;
  hq_rate: number;
  direct_rate: number;
  multi_project: boolean;
  supplemental_files: Record<string, SupplementalFileSpec>;
  old_to_new_codes: Record<string, string>;
  code_blocklist?: string[];
  coord_keywords: string[];
  exclude_keywords: string[];
  compilation_patterns: string[];
}

export function hqRateStr(config: OCConfig): string {
  if (config.hq_rate === 0) return '';
  return `${Math.round(config.hq_rate * 100)}%`;
}

export function directRateStr(config: OCConfig): string {
  if (config.direct_rate === 0) return '';
  return `${Math.round(config.direct_rate * 100)}%`;
}

export function loadOCConfig(ocName: string): OCConfig {
  const data = RAW_CONFIGS[ocName.toLowerCase()];
  if (!data) {
    throw new Error(`OC config not found: ${ocName}`);
  }
  return {
    name: data.name as string,
    code_regex: data.code_regex as string,
    code_prefix: (data.code_prefix as string) || '',
    hq_rate: (data.hq_rate as number) || 0,
    direct_rate: (data.direct_rate as number) || 0,
    multi_project: (data.multi_project as boolean) || false,
    supplemental_files:
      (data.supplemental_files as Record<string, SupplementalFileSpec>) || {},
    old_to_new_codes: (data.old_to_new_codes as Record<string, string>) || {},
    code_blocklist: (data.code_blocklist as string[]) || [],
    coord_keywords: (data.coord_keywords as string[]) || [
      'coordination',
      'coodination',
      'mission',
      'strategy',
    ],
    exclude_keywords: (data.exclude_keywords as string[]) || [],
    compilation_patterns: (data.compilation_patterns as string[]) || [],
  };
}

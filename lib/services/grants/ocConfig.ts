/**
 * Per-OC (Operating Company) configuration.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const CONFIGS_DIR = join(
  process.cwd(),
  'lib',
  'services',
  'grants',
  'oc-configs',
);

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
  const path = join(CONFIGS_DIR, `${ocName.toLowerCase()}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw new Error(`OC config file not found: ${path}`);
  }
  const data = JSON.parse(raw);
  return {
    name: data.name,
    code_regex: data.code_regex,
    code_prefix: data.code_prefix || '',
    hq_rate: data.hq_rate || 0,
    direct_rate: data.direct_rate || 0,
    multi_project: data.multi_project || false,
    supplemental_files: data.supplemental_files || {},
    old_to_new_codes: data.old_to_new_codes || {},
    coord_keywords: data.coord_keywords || [
      'coordination',
      'coodination',
      'mission',
      'strategy',
    ],
    exclude_keywords: data.exclude_keywords || [],
    compilation_patterns: data.compilation_patterns || [],
  };
}

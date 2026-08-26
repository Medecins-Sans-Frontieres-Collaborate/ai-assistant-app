/**
 * Loads .env.local for standalone eval runs without importing
 * config/environment.ts (whose zod validation expects a full app env).
 */
import { config } from 'dotenv';
import path from 'path';

let loaded = false;

export function loadEvalEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = process.env.EVAL_ENV_FILE ?? '.env.local';
  config({ path: path.resolve(process.cwd(), file), quiet: true });
}

export function envString(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

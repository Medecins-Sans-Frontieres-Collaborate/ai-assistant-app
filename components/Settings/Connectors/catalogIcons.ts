import {
  IconBrandAsana,
  IconBrandGithub,
  IconChartBar,
  IconCloud,
  IconPlugConnected,
  IconSpeakerphone,
} from '@tabler/icons-react';
import { FC } from 'react';

/**
 * Icons for catalog connectors. Lives here rather than in a row component so
 * the browser list and the configured row show the same mark — a connector
 * that changes appearance when you add it reads as a different thing.
 *
 * Tabler has no brand glyph for Tableau, Salesforce, or Hootsuite, so those
 * fall back to a category icon rather than a wrong brand mark. `IconPlugConnected`
 * is the last resort for any entry added without a mapping.
 */
export const CATALOG_ICONS: Record<
  string,
  FC<{ size?: number; className?: string }>
> = {
  github: IconBrandGithub,
  asana: IconBrandAsana,
  tableau: IconChartBar,
  salesforce: IconCloud,
  hootsuitePerch: IconSpeakerphone,
  hootsuiteNest: IconSpeakerphone,
};

export function catalogIcon(
  key: string,
): FC<{ size?: number; className?: string }> {
  return CATALOG_ICONS[key] ?? IconPlugConnected;
}

import {
  IconBrain,
  IconDatabase,
  IconDeviceDesktop,
  IconHelp,
  IconLeaf,
  IconMessage,
  IconPlugConnected,
  IconSettings,
  IconUserShield,
} from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { ComponentType } from 'react';

import { useTranslations } from 'next-intl';

import { useAdminAreas } from '@/client/hooks/settings/useAdminAreas';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import { SettingsSection } from './types';

/**
 * Structural rather than Tabler's own `Icon` export, which is a namespace in
 * v3 and can't be used as a type. This is all the call sites need: each
 * renders the icon via `createElement(icon, { size })`.
 */
type NavIcon = ComponentType<{ size?: number | string; className?: string }>;

/**
 * A section the dialog can show, or an outbound link rendered alongside them
 * (Agent Access navigates to its own admin page rather than swapping the
 * dialog's pane).
 */
export type SettingsNavItem =
  | {
      kind: 'section';
      section: SettingsSection;
      label: string;
      icon: NavIcon;
    }
  | {
      kind: 'link';
      href: string;
      label: string;
      icon: NavIcon;
    };

/**
 * The single source of truth for settings navigation.
 *
 * Both the desktop sidebar and the mobile sheet render from this list. They
 * used to keep their own hardcoded copies (plus a third, dead one in
 * MobileNavigation.tsx), and they drifted: mobile was missing Usage & Impact,
 * Backup, Memories, Local Models, Agent Access and Reset Settings, consulted
 * only one of the five LaunchDarkly flags, and offered an `ACCOUNT` entry that
 * SettingDialog never rendered — a menu item that opened a blank pane.
 *
 * Flag polarity is deliberate and mixed; it is preserved exactly as the
 * desktop sidebar had it. See docs/LAUNCHDARKLY_FLAGS.md.
 */
export function useSettingsNav(): SettingsNavItem[] {
  const t = useTranslations();
  const {
    showUsageImpact,
    mcpConnectors,
    enableEncryptedBackups,
    enableMemories,
    localModels,
  } = useFlags();
  const { filesEnabled: m365FilesEnabled, mailEnabled: m365MailEnabled } =
    useM365Enabled();

  // Fail-open: undefined (LD unconfigured/unserved) → shown. Flip to false in
  // LaunchDarkly to hide the section.
  const isUsageImpactEnabled = showUsageImpact !== false;
  const isConnectorsEnabled = mcpConnectors !== false;
  // Fail-closed (`=== true`) — deliberately the opposite polarity of the flags
  // above: encrypted backup must stay hidden until LD explicitly serves the
  // flag as true (like mcpArbitraryServers).
  const isBackupEnabled = enableEncryptedBackups === true;
  // Fail-closed (`=== true`): memories stay hidden until LD explicitly serves
  // the flag as true (same rationale as encrypted backup).
  const isMemoriesEnabled = enableMemories === true;
  // Fail-closed (`=== true`): local models depend on browser behavior we can't
  // control (Chrome's Local Network Access permission, enterprise policy), so
  // the flag is the feature's kill switch — it must never default on.
  const isLocalModelsEnabled = localModels === true;
  // Fail-closed with a localhost escape hatch (see useM365Enabled). Either
  // capability shows the Connections section (the section itself explains
  // what's available).
  const isConnectionsEnabled = m365FilesEnabled || m365MailEnabled;

  // ONE entry for every admin area. Visibility only — each admin page's
  // server component is the real gate.
  //
  // Resolved server-side rather than from useAgentAccessAdmin: that hook's
  // query is disabled when AGENT_ACCESS_CONTROL_ENABLED is false, so a
  // deployment running usage limits WITHOUT agent access used to show a global
  // admin no admin entry at all.
  const { isAdmin: hasAnyAdminArea } = useAdminAreas();

  const section = (
    id: SettingsSection,
    label: string,
    icon: NavIcon,
  ): SettingsNavItem => ({ kind: 'section', section: id, label, icon });

  return [
    section(SettingsSection.GENERAL, t('settings.General'), IconSettings),
    section(
      SettingsSection.CHAT_SETTINGS,
      t('settings.Chat Settings'),
      IconMessage,
    ),
    // ONE entry for everything the user connects to the app: Microsoft 365
    // and MCP connectors were near-synonym siblings ("Connections" vs
    // "Connectors"); the pane shows whichever blocks the flags allow.
    ...(isConnectorsEnabled || isConnectionsEnabled
      ? [
          section(
            SettingsSection.CONNECTIONS,
            t('settings.Connections'),
            IconPlugConnected,
          ),
        ]
      : []),
    ...(isUsageImpactEnabled
      ? [
          section(
            SettingsSection.USAGE_IMPACT,
            t('settings.Usage & Impact'),
            IconLeaf,
          ),
        ]
      : []),
    ...(isMemoriesEnabled
      ? [section(SettingsSection.MEMORIES, t('settings.Memories'), IconBrain)]
      : []),
    ...(isLocalModelsEnabled
      ? [
          section(
            SettingsSection.LOCAL_MODELS,
            t('settings.LocalModels'),
            IconDeviceDesktop,
          ),
        ]
      : []),
    ...(hasAnyAdminArea
      ? [
          {
            kind: 'link' as const,
            href: '/admin',
            label: t('settings.Admin'),
            icon: IconUserShield,
          },
        ]
      : []),
    // Cloud backup lives INSIDE this pane when its flag allows — the label
    // widens so users looking for "backup" find the right (only) place.
    section(
      SettingsSection.DATA_MANAGEMENT,
      isBackupEnabled
        ? t('settings.DataBackup')
        : t('settings.Data Management'),
      IconDatabase,
    ),
    // Help & Support hosts the Mobile App card as a subsection.
    section(
      SettingsSection.HELP_SUPPORT,
      t('settings.Help & Support'),
      IconHelp,
    ),
  ];
}

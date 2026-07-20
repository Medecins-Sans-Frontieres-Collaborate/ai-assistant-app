import {
  type Icon,
  IconBrain,
  IconDatabase,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconHelp,
  IconLeaf,
  IconMessage,
  IconPlugConnected,
  IconSettings,
  IconShieldLock,
  IconUserShield,
} from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';

import { useTranslations } from 'next-intl';

import { useAgentAccessAdmin } from '@/client/hooks/settings/useAgentAccessAdmin';

import { SettingsSection } from './types';

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
      icon: Icon;
    }
  | {
      kind: 'link';
      href: string;
      label: string;
      icon: Icon;
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

  // Visibility only — the admin page's server component is the real gate.
  const { isAdmin: isAgentAccessAdmin } = useAgentAccessAdmin();

  const section = (
    id: SettingsSection,
    label: string,
    icon: Icon,
  ): SettingsNavItem => ({ kind: 'section', section: id, label, icon });

  return [
    section(SettingsSection.GENERAL, t('settings.General'), IconSettings),
    section(
      SettingsSection.CHAT_SETTINGS,
      t('settings.Chat Settings'),
      IconMessage,
    ),
    ...(isConnectorsEnabled
      ? [
          section(
            SettingsSection.CONNECTORS,
            t('settings.Connectors'),
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
    ...(isBackupEnabled
      ? [section(SettingsSection.BACKUP, t('settings.Backup'), IconShieldLock)]
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
    ...(isAgentAccessAdmin
      ? [
          {
            kind: 'link' as const,
            href: '/admin/agent-access',
            label: t('settings.Agent Access'),
            icon: IconUserShield,
          },
        ]
      : []),
    section(
      SettingsSection.DATA_MANAGEMENT,
      t('settings.Data Management'),
      IconDatabase,
    ),
    section(
      SettingsSection.MOBILE_APP,
      t('settings.Mobile App'),
      IconDeviceMobile,
    ),
    section(
      SettingsSection.HELP_SUPPORT,
      t('settings.Help & Support'),
      IconHelp,
    ),
  ];
}

/**
 * Enum representing the different sections of the settings dialog
 */
export enum SettingsSection {
  GENERAL = 'GENERAL',
  CHAT_SETTINGS = 'CHAT_SETTINGS',
  CONNECTORS = 'CONNECTORS',
  USAGE_IMPACT = 'USAGE_IMPACT',
  BACKUP = 'BACKUP',
  MEMORIES = 'MEMORIES',
  LOCAL_MODELS = 'LOCAL_MODELS',
  DATA_MANAGEMENT = 'DATA_MANAGEMENT',
  // ACCOUNT removed: SettingDialog never rendered a pane for it, so the mobile
  // menu entry that pointed here opened a blank screen.
  MOBILE_APP = 'MOBILE_APP',
  HELP_SUPPORT = 'HELP_SUPPORT',
}

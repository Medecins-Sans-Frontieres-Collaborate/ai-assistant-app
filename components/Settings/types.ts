/**
 * Enum representing the different sections of the settings dialog
 */
export enum SettingsSection {
  GENERAL = 'GENERAL',
  CHAT_SETTINGS = 'CHAT_SETTINGS',
  // CONNECTORS folded into CONNECTIONS: "Connectors" (MCP) and "Connections"
  // (Microsoft 365) were near-synonym siblings; one pane now hosts both,
  // each block behind its own flag.
  CONNECTIONS = 'CONNECTIONS',
  USAGE_IMPACT = 'USAGE_IMPACT',
  // BACKUP folded into DATA_MANAGEMENT ("Data & Backup" when the flag is
  // on): two adjacent panes both called backup confused users about which
  // one owned their data.
  MEMORIES = 'MEMORIES',
  LOCAL_MODELS = 'LOCAL_MODELS',
  DATA_MANAGEMENT = 'DATA_MANAGEMENT',
  // ACCOUNT removed: SettingDialog never rendered a pane for it, so the mobile
  // menu entry that pointed here opened a blank screen.
  // MOBILE_APP folded into HELP_SUPPORT: a two-card info pane didn't earn a
  // top-level nav slot.
  HELP_SUPPORT = 'HELP_SUPPORT',
}

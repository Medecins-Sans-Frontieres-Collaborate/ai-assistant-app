/**
 * External Links and URLs
 * Centralized location for all external links used throughout the application
 */

export const EXTERNAL_LINKS = {
  // Support & Help
  SUPPORT_FORM: 'https://forms.office.com/e/N9ZbsqATNx',
  SUPPORT_FORM_EMBED: 'https://forms.office.com/e/N9ZbsqATNx?embed=true',

  // Project Resources
  SHAREPOINT_PORTAL:
    'https://msfintl.sharepoint.com/sites/PamojaPortal_AIAccelerator',
  GITHUB_REPOSITORY:
    'https://github.com/Medecins-Sans-Frontieres-Collaborate/ai-assistant-app',
} as const;

export type ExternalLink = keyof typeof EXTERNAL_LINKS;

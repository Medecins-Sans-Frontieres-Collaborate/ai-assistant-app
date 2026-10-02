import {
  IconBook,
  IconChartBar,
  IconForms,
  IconGauge,
  IconMap2,
  IconMasksTheater,
  IconMessages,
  IconPlugConnected,
  IconRobot,
  IconRoute,
  IconShieldLock,
  IconSocial,
  IconSpeakerphone,
  IconUserShield,
  IconUsersGroup,
  IconVocabulary,
  IconWorldSearch,
} from '@tabler/icons-react';
import { ComponentType } from 'react';

import { AdminAreaId } from '@/lib/services/admin/adminAreas';

type AreaIcon = ComponentType<{ size?: number | string; className?: string }>;

export type AdminAreaGroup =
  | 'capabilities'
  | 'libraries'
  | 'usage'
  | 'administration';

export interface AdminAreaDescriptor {
  id: AdminAreaId;
  href: string;
  icon: AreaIcon;
  /**
   * ⚠ These reuse keys that ALREADY exist in all 53 locales, so the rail is
   * translated on day one rather than shipping English into every other
   * language. Renaming `agentAccess.*Tab` or `limits.title` silently breaks
   * these labels — there is a matching warning in messages/en.json's owners.
   */
  labelKey: string;
  /** Rendered as the rail item's tooltip, so every entry can say what it is. */
  descriptionKey: string;
}

/**
 * Presentation registry for the admin area rail.
 *
 * Membership and ORDER both live in `ADMIN_GROUPS` below, never here — see the
 * comment there for why.
 *
 * Prompt agents is deliberately NOT a separate area: AgentAccessPanel merges
 * Foundry discovery, stored rules and prompt agents into one row list so a
 * single editor answers "who can use this" for both kinds. Splitting them
 * would separate a prompt agent from its own access control.
 */
export const ADMIN_AREAS: Record<AdminAreaId, AdminAreaDescriptor> = {
  agents: {
    id: 'agents',
    href: '/admin/agents',
    icon: IconRobot,
    labelKey: 'agentAccess.agentsTab',
    descriptionKey: 'admin.areaDescription.agents',
  },
  connectors: {
    id: 'connectors',
    href: '/admin/connectors',
    icon: IconPlugConnected,
    labelKey: 'agentAccess.connectorsTab',
    descriptionKey: 'admin.areaDescription.connectors',
  },
  workflows: {
    id: 'workflows',
    href: '/admin/workflows',
    icon: IconRoute,
    labelKey: 'admin.area.workflows',
    descriptionKey: 'admin.areaDescription.workflows',
  },
  'web-search': {
    id: 'web-search',
    href: '/admin/web-search',
    icon: IconWorldSearch,
    labelKey: 'admin.area.webSearch',
    descriptionKey: 'admin.areaDescription.webSearch',
  },
  guides: {
    id: 'guides',
    href: '/admin/guides',
    icon: IconBook,
    labelKey: 'agentAccess.guidesTab',
    descriptionKey: 'admin.areaDescription.guides',
  },
  glossaries: {
    id: 'glossaries',
    href: '/admin/glossaries',
    icon: IconVocabulary,
    labelKey: 'agentAccess.glossariesTab',
    descriptionKey: 'admin.areaDescription.glossaries',
  },
  'map-datasets': {
    id: 'map-datasets',
    href: '/admin/map-datasets',
    icon: IconMap2,
    labelKey: 'agentAccess.datasetsTab',
    descriptionKey: 'admin.areaDescription.mapDatasets',
  },
  'form-templates': {
    id: 'form-templates',
    href: '/admin/form-templates',
    icon: IconForms,
    labelKey: 'agentAccess.formTemplatesTab',
    descriptionKey: 'admin.areaDescription.formTemplates',
  },
  'channel-sets': {
    id: 'channel-sets',
    href: '/admin/channel-sets',
    icon: IconMessages,
    labelKey: 'agentAccess.channelSetsTab',
    descriptionKey: 'admin.areaDescription.channelSets',
  },
  'channel-profiles': {
    id: 'channel-profiles',
    href: '/admin/channel-profiles',
    icon: IconSocial,
    labelKey: 'agentAccess.channelProfilesTab',
    descriptionKey: 'admin.areaDescription.channelProfiles',
  },
  limits: {
    id: 'limits',
    href: '/admin/limits',
    icon: IconGauge,
    labelKey: 'limits.title',
    descriptionKey: 'limits.description',
  },
  analytics: {
    id: 'analytics',
    href: '/admin/analytics',
    icon: IconChartBar,
    labelKey: 'admin.area.analytics',
    descriptionKey: 'admin.areaDescription.analytics',
  },
  announcements: {
    id: 'announcements',
    href: '/admin/announcements',
    icon: IconSpeakerphone,
    labelKey: 'admin.area.announcements',
    descriptionKey: 'admin.areaDescription.announcements',
  },
  delegations: {
    id: 'delegations',
    href: '/admin/delegations',
    icon: IconUserShield,
    labelKey: 'admin.area.delegations',
    descriptionKey: 'admin.areaDescription.delegations',
  },
  'local-admins': {
    id: 'local-admins',
    href: '/admin/local-admins',
    icon: IconUsersGroup,
    labelKey: 'agentAccess.localAdminsTab',
    descriptionKey: 'admin.areaDescription.localAdmins',
  },
  'global-admins': {
    id: 'global-admins',
    href: '/admin/global-admins',
    icon: IconShieldLock,
    labelKey: 'admin.area.globalAdmins',
    descriptionKey: 'admin.areaDescription.globalAdmins',
  },
  'view-as': {
    id: 'view-as',
    href: '/admin/view-as',
    icon: IconMasksTheater,
    labelKey: 'admin.area.viewAs',
    descriptionKey: 'admin.areaDescription.viewAs',
  },
};

export interface AdminAreaGroupDescriptor {
  id: AdminAreaGroup;
  labelKey: string;
  /** Rail order within the group. */
  areas: AdminAreaId[];
}

/**
 * The rail's structure: which groups exist, in which order, holding which
 * areas, in which order.
 *
 * ⚠ ORDER LIVES HERE, NOT IN `resolveAdminAreas`. The nav used to render a
 * group by filtering the resolver's output, which meant rail order was
 * whatever order the permission branches happened to push in — so
 * `channel-profiles` and `workflows`, granted in later branches, sank to the
 * bottom of their group, and two admins with different rights saw the same
 * group in different orders. The resolver answers "may this person open it";
 * this file answers "where does it sit". `areas.test.ts` asserts every
 * AdminAreaId appears here exactly once, so a new area cannot be added to the
 * resolver and silently vanish from the rail.
 *
 * Grouping is by what an admin is TRYING TO DO, not by which service stores
 * the data:
 *
 *  - capabilities:   what the assistant can do, and who may use it
 *  - libraries:      reference content the assistant and its workflows draw on
 *  - usage:          how much people may use
 *  - administration: who administers the above, and what reaches users
 *
 * The libraries group is the reason this split exists. Guides, glossaries,
 * datasets, templates, channel sets and platforms all carry access rules,
 * which is how they ended up under a single "Access" heading with agents and
 * connectors — nine of fifteen areas in one bucket. Having a rule attached is
 * not what they ARE: an admin opens them to author content, not to grant
 * something.
 */
export const ADMIN_GROUPS: AdminAreaGroupDescriptor[] = [
  {
    id: 'capabilities',
    labelKey: 'admin.group.capabilities',
    areas: ['agents', 'connectors', 'workflows', 'web-search'],
  },
  {
    id: 'libraries',
    labelKey: 'admin.group.libraries',
    areas: [
      'guides',
      'glossaries',
      'map-datasets',
      'form-templates',
      'channel-sets',
      // The organisation-wide platform facts every channel set builds on, so
      // it reads as a footnote to the sets rather than a peer of them.
      'channel-profiles',
    ],
  },
  {
    id: 'usage',
    labelKey: 'admin.group.usage',
    areas: ['limits', 'analytics'],
  },
  {
    id: 'administration',
    labelKey: 'admin.group.administration',
    areas: [
      'announcements',
      'delegations',
      'local-admins',
      'global-admins',
      // A testing tool, not a configuration: last on purpose.
      'view-as',
    ],
  },
];

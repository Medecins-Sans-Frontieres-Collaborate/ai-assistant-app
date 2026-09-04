import {
  IconBook,
  IconGauge,
  IconMap2,
  IconMasksTheater,
  IconPlugConnected,
  IconRobot,
  IconRoute,
  IconShieldLock,
  IconUsersGroup,
} from '@tabler/icons-react';
import { ComponentType } from 'react';

import { AdminAreaId } from '@/lib/services/admin/adminAreas';

type AreaIcon = ComponentType<{ size?: number | string; className?: string }>;

export type AdminAreaGroup = 'access' | 'usage' | 'administration';

export interface AdminAreaDescriptor {
  id: AdminAreaId;
  href: string;
  icon: AreaIcon;
  group: AdminAreaGroup;
  /**
   * ⚠ These reuse keys that ALREADY exist in all 53 locales, so the rail is
   * translated on day one rather than shipping English into every other
   * language. Renaming `agentAccess.*Tab` or `limits.title` silently breaks
   * these labels — there is a matching warning in messages/en.json's owners.
   */
  labelKey: string;
  descriptionKey: string;
}

/**
 * Presentation registry for the admin area rail. Grouping is by what an admin
 * is trying to DO, not by which service happens to store the data:
 *
 *  - access:         who can use what
 *  - usage:          how much they may use
 *  - administration: who administers the above
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
    group: 'access',
    labelKey: 'agentAccess.agentsTab',
    descriptionKey: 'admin.areaDescription.agents',
  },
  connectors: {
    id: 'connectors',
    href: '/admin/connectors',
    icon: IconPlugConnected,
    group: 'access',
    labelKey: 'agentAccess.connectorsTab',
    descriptionKey: 'admin.areaDescription.connectors',
  },
  guides: {
    id: 'guides',
    href: '/admin/guides',
    icon: IconBook,
    group: 'access',
    labelKey: 'agentAccess.guidesTab',
    descriptionKey: 'admin.areaDescription.guides',
  },
  'map-datasets': {
    id: 'map-datasets',
    href: '/admin/map-datasets',
    icon: IconMap2,
    group: 'access',
    labelKey: 'agentAccess.datasetsTab',
    descriptionKey: 'admin.areaDescription.mapDatasets',
  },
  limits: {
    id: 'limits',
    href: '/admin/limits',
    icon: IconGauge,
    group: 'usage',
    labelKey: 'limits.title',
    descriptionKey: 'limits.description',
  },
  workflows: {
    id: 'workflows',
    href: '/admin/workflows',
    icon: IconRoute,
    group: 'access',
    labelKey: 'admin.area.workflows',
    descriptionKey: 'admin.areaDescription.workflows',
  },
  'local-admins': {
    id: 'local-admins',
    href: '/admin/local-admins',
    icon: IconUsersGroup,
    group: 'administration',
    labelKey: 'agentAccess.localAdminsTab',
    descriptionKey: 'admin.areaDescription.localAdmins',
  },
  'global-admins': {
    id: 'global-admins',
    href: '/admin/global-admins',
    icon: IconShieldLock,
    group: 'administration',
    labelKey: 'admin.area.globalAdmins',
    descriptionKey: 'admin.areaDescription.globalAdmins',
  },
  'view-as': {
    id: 'view-as',
    href: '/admin/view-as',
    icon: IconMasksTheater,
    group: 'administration',
    labelKey: 'admin.area.viewAs',
    descriptionKey: 'admin.areaDescription.viewAs',
  },
};

export const ADMIN_GROUP_ORDER: AdminAreaGroup[] = [
  'access',
  'usage',
  'administration',
];

export const ADMIN_GROUP_LABEL_KEY: Record<AdminAreaGroup, string> = {
  access: 'admin.group.access',
  usage: 'admin.group.usage',
  administration: 'admin.group.administration',
};

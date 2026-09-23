/**
 * Client messages carried by the `/api/version` poll — the ONE funnel every
 * open client already polls (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §3). The
 * server decides what is queued for the caller; the client renders the list
 * in the order given.
 *
 * System kinds (`update`) carry NO text: the client renders them from its own
 * locale strings and keeps their special actions (Refresh, What changed).
 */
import { AnnouncementVariable } from '@/lib/services/announcements/types';

export interface UpdateAppMessage {
  kind: 'update';
}

export interface AnnouncementAppMessage {
  kind: 'announcement';
  id: string;
  revision: number;
  severity: 'info' | 'warning' | 'critical';
  dismissible: boolean;
  /** Already in the reader's language (or the source language). */
  title: string;
  body: string;
  action?: { label: string; url: string };
  variables: AnnouncementVariable[];
  /** Delegation label for a delegated announcement; absent for org-wide. */
  from?: string;
  /** When this stops being delivered — lets the client prune dismissals. */
  endsAt: string;
}

export type AppMessage = UpdateAppMessage | AnnouncementAppMessage;

export interface VersionResponse {
  /** MUST stay top-level: old tabs read only this. */
  build: string;
  messages: AppMessage[];
}

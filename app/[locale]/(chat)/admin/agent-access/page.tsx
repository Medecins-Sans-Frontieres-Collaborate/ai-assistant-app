import { redirect } from 'next/navigation';

/**
 * Legacy path. Kept alive permanently: it is linked from the settings nav
 * history, from MapDatasetEditor's back link, and from any bookmark an admin
 * already has.
 */
export default function AgentAccessRedirectPage() {
  redirect('/admin/agents');
}

'use client';

import {
  IconAlertTriangle,
  IconCloudLock,
  IconExternalLink,
  IconLockOpen,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useM365Enabled } from '@/client/hooks/useM365Enabled';

interface PreflightSource {
  sourceId: string;
  title: string;
  accessible: boolean;
  webUrl?: string;
  ownerDisplay?: string;
}

interface PreflightResponse {
  connected: boolean;
  agentName?: string;
  /**
   * Graph gave no definitive answer for at least one source (throttled or
   * errored): the server did not cache the verdict, and "no access" would
   * be a false claim — say "couldn't verify" and offer a retry instead.
   */
  unverifiable?: boolean;
  sources: PreflightSource[];
}

/** Preflight HTTP failure, carrying the status so a 404 (layer-1 deny or a
 * deleted agent) renders differently from a transport/throttle error. */
class PreflightError extends Error {
  constructor(readonly status: number) {
    super(`Preflight failed (${status})`);
  }
}

/**
 * The automated permission experience for M365 file-backed agents
 * (requirement 1 of docs/M365_SECOND_PASS_AGENTS_DESIGN.md): when an M365
 * agent is selected, preflight the caller's per-source access and render
 * one of the four states — connect first / all accessible (nothing) /
 * partial (banner, chat still works over the accessible subset) / none
 * (banner; the server rejects invocations anyway).
 *
 * Advisory UI only: enforcement is the server-side layer-2 trim. The
 * request-access links land on OneDrive/SharePoint's native Request access
 * flow (each denied source's webUrl).
 */
export const M365AgentAccessBanner: FC<{ botId: string | undefined }> = ({
  botId,
}) => {
  const t = useTranslations('m365.agentAccess');
  const { agentsEnabled } = useM365Enabled();
  const isM365Agent = !!botId && /^m365-[a-f0-9]{12}$/.test(botId);

  const preflight = useQuery<PreflightResponse>({
    queryKey: ['m365-agent-access', botId],
    queryFn: async () => {
      const response = await fetch(
        `/api/m365/agents/${encodeURIComponent(botId!)}/access`,
      );
      if (!response.ok) {
        throw new PreflightError(response.status);
      }
      const body = await response.json();
      return body.data as PreflightResponse;
    },
    enabled: agentsEnabled && isM365Agent,
    // Mirrors the server's probe cache TTL.
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  if (!agentsEnabled || !isM365Agent) return null;

  // Preflight failed (502 Graph transport/throttle, 503 rules unavailable,
  // timeout) or the agent is not reachable for this user (404: layer-1 deny
  // or deleted). Hiding the banner here left the user to discover the
  // problem only when their message was rejected — say it up front.
  const unverifiable =
    !preflight.isError &&
    preflight.data?.connected === true &&
    preflight.data.unverifiable === true &&
    preflight.data.sources.some((s) => !s.accessible);
  if (preflight.isError || unverifiable) {
    const status =
      preflight.error instanceof PreflightError ? preflight.error.status : 0;
    const notAvailable = status === 404;
    return (
      <div
        role="status"
        className="mx-2 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200 md:mx-4"
      >
        <div className="flex items-start gap-2">
          <IconAlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p>{notAvailable ? t('notAvailable') : t('verifyFailed')}</p>
            {!notAvailable && (
              <button
                type="button"
                onClick={() => void preflight.refetch()}
                disabled={preflight.isFetching}
                className="mt-1 text-xs font-medium underline disabled:opacity-50"
              >
                {t('retry')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!preflight.data) return null;

  const { connected, sources } = preflight.data;
  const denied = sources.filter((s) => !s.accessible);

  if (connected && denied.length === 0) return null;

  const noneAccessible = connected && denied.length === sources.length;

  return (
    <div
      role="status"
      className="mx-2 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200 md:mx-4"
    >
      <div className="flex items-start gap-2">
        <IconCloudLock size={18} className="mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          {!connected ? (
            <p>{t('connectFirst')}</p>
          ) : (
            <>
              <p className="font-medium">
                {noneAccessible
                  ? t('noSourcesAccessible')
                  : t('partialAccess', {
                      denied: denied.length,
                      total: sources.length,
                    })}
              </p>
              <ul className="mt-1 space-y-0.5">
                {denied.map((source) => (
                  <li
                    key={source.sourceId}
                    className="flex items-center gap-1.5 text-xs"
                  >
                    <span className="truncate">
                      {source.title}
                      {source.ownerDisplay &&
                        ` — ${t('ownedBy', { owner: source.ownerDisplay })}`}
                    </span>
                    {source.webUrl && (
                      <a
                        href={source.webUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex flex-shrink-0 items-center gap-0.5 font-medium underline"
                      >
                        <IconLockOpen size={12} />
                        {t('requestAccess')}
                        <IconExternalLink size={11} />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs opacity-80">
                {noneAccessible ? t('noneHint') : t('partialHint')}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

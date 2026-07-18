'use client';

import {
  IconAlertTriangle,
  IconBrandAsana,
  IconBrandGithub,
  IconCheck,
  IconExternalLink,
  IconPlugConnected,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useMcpTools } from '@/client/hooks/settings/useMcpTools';

import { connectMcpOauth } from '@/client/services/mcp/mcpOauth';

import { OwnOauthAppFields } from './OwnOauthAppFields';
import { validateMcpServer } from './validateMcpServer';

import {
  McpServerConfig,
  useSettingsStore,
} from '@/client/stores/settingsStore';
import { McpCatalogEntry } from '@/config/mcpCatalog';

/** Catalog icons live here (the catalog module stays React-free). */
const CATALOG_ICONS: Record<
  string,
  FC<{ size?: number; className?: string }>
> = {
  github: IconBrandGithub,
  asana: IconBrandAsana,
};

interface CuratedConnectorRowProps {
  entry: McpCatalogEntry;
  /** The saved config for this catalog entry, if connected. */
  config?: McpServerConfig;
  /**
   * Whether this deployment has an OAuth app for this connector. False hides
   * "Connect with {name}" — there is nothing to tie into, so the click could
   * only end in oauth_unavailable. Bringing your own app still works.
   */
  oauthAppAvailable?: boolean;
}

/**
 * One curated connector. Auth-style-aware:
 * - bearer/header: inline token field, validated before saving; connected
 *   state shows the token tail. Tokens are never rendered back.
 * - oauth: "Connect with {name}" runs the popup PKCE flow
 *   (client/services/mcp/mcpOauth.ts); needsReauth shows an amber
 *   "Reconnect" that reuses the registered client id.
 * - dual (bearer + alsoSupportsOauth, e.g. GitHub): OAuth is the primary
 *   button, "Use an access token instead" reveals the PAT fallback. The
 *   connected state renders from the SAVED config's authMode, whichever
 *   path was used.
 *
 * All OAuth affordances are additionally gated on `oauthAppAvailable`: a
 * deployment with no MCP_OAUTH_*_CLIENT_ID has no app for the user to tie
 * into, and the providers offer no usable web-app DCR, so the button is
 * hidden rather than left to fail after a popup round-trip. Bringing your
 * own app stays available and re-enables it.
 */
export const CuratedConnectorRow: FC<CuratedConnectorRowProps> = ({
  entry,
  config,
  oauthAppAvailable = true,
}) => {
  const t = useTranslations('connectors');
  const tCommon = useTranslations('common');
  const addMcpServer = useSettingsStore((s) => s.addMcpServer);
  const updateMcpServer = useSettingsStore((s) => s.updateMcpServer);
  const deleteMcpServer = useSettingsStore((s) => s.deleteMcpServer);

  const [expanded, setExpanded] = useState(false);
  const [token, setToken] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Bring your own OAuth app": user-registered app credentials (their own
  // GitHub org / Asana workspace / enterprise instance) taking precedence
  // over DCR and the deployment-wide MCP_OAUTH_* app.
  const [showOwnApp, setShowOwnApp] = useState(false);
  const [ownClientId, setOwnClientId] = useState('');
  const [ownClientSecret, setOwnClientSecret] = useState('');

  const { tools, isLoadingTools } = useMcpTools(config);

  const Icon = CATALOG_ICONS[entry.key] ?? IconPlugConnected;
  const oauthSupported =
    entry.auth.style === 'oauth' || !!entry.alsoSupportsOauth;
  const patAvailable =
    entry.auth.style === 'bearer' || entry.auth.style === 'header';
  // An own-app client id — saved from a previous connect, or being typed
  // right now — is itself something to tie into, so it re-enables the button
  // on deployments with no app of their own.
  const ownAppReady = !!config?.oauthApp || !!ownClientId.trim();
  /** Can a "Connect with {name}" click actually reach a provider app? */
  const canStartOauth = oauthSupported && (oauthAppAvailable || ownAppReady);
  // Connected state renders from the SAVED config's auth mode — for dual-
  // auth entries (GitHub) that's whichever path the user actually used.
  const connectedViaOauth = config?.authMode === 'oauth';
  const needsReauth = !!config?.oauth?.needsReauth;
  const last4 =
    !connectedViaOauth && config?.authToken ? config.authToken.slice(-4) : '';

  const handleConnectToken = async () => {
    if (!token.trim()) {
      setError(t('tokenRequired'));
      return;
    }
    setIsBusy(true);
    setError(null);
    const result = await validateMcpServer({
      id: entry.key,
      name: entry.label,
      catalogKey: entry.key,
      authToken: token.trim(),
    });
    setIsBusy(false);
    if (!result.ok) {
      setError(
        result.errorKind === 'auth' ? t('authFailed') : t('validationFailed'),
      );
      return;
    }
    addMcpServer({
      id: entry.key,
      catalogKey: entry.key,
      name: entry.label,
      url: '',
      authMode: entry.auth.style === 'header' ? 'header' : 'bearer',
      authToken: token.trim(),
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    setToken('');
    setExpanded(false);
  };

  const handleConnectOauth = async () => {
    setIsBusy(true);
    setError(null);
    // Credential precedence: freshly entered own app → previously saved own
    // app → prior DCR/deployment client (reconnect path) → fresh register.
    const ownApp = ownClientId.trim()
      ? {
          clientId: ownClientId.trim(),
          ...(ownClientSecret.trim()
            ? { clientSecret: ownClientSecret.trim() }
            : {}),
        }
      : config?.oauthApp;
    try {
      const oauth = await connectMcpOauth(
        { id: entry.key, name: entry.label, catalogKey: entry.key },
        ownApp?.clientId ?? config?.oauth?.clientId,
        ownApp?.clientSecret ?? config?.oauth?.clientSecret,
      );
      if (config) {
        // Reconnect (or a dual-auth switch to OAuth): drop any stored PAT so
        // exactly one credential exists per connector.
        updateMcpServer(config.id, {
          authMode: 'oauth',
          authToken: undefined,
          oauth,
          oauthApp: ownApp,
          enabled: true,
        });
      } else {
        addMcpServer({
          id: entry.key,
          catalogKey: entry.key,
          name: entry.label,
          url: '',
          authMode: 'oauth',
          oauth,
          oauthApp: ownApp,
          enabled: true,
          createdAt: new Date().toISOString(),
        });
      }
      setOwnClientId('');
      setOwnClientSecret('');
      setShowOwnApp(false);
    } catch (flowError) {
      const kind =
        flowError instanceof Error ? flowError.message : 'oauth_failed';
      setError(
        kind === 'oauth_denied'
          ? t('oauthDenied')
          : kind === 'oauth_timeout'
            ? t('oauthTimeout')
            : kind === 'oauth_cancelled'
              ? t('oauthCancelled')
              : kind === 'oauth_unavailable'
                ? t('oauthUnavailable')
                : t('oauthFailed'),
      );
    } finally {
      setIsBusy(false);
    }
  };

  const isConnected =
    !!config && (!connectedViaOauth || !!config.oauth?.accessToken);
  // With no deployment app and no token fallback (an oauth-only connector on
  // an unconfigured deployment), bringing your own app is the ONLY way in —
  // so reveal those fields instead of leaving an empty row behind a toggle.
  const ownAppForced =
    !config && oauthSupported && !oauthAppAvailable && !patAvailable;
  const showOwnAppFields = showOwnApp || ownAppForced;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-start gap-3">
        <Icon
          size={24}
          className="mt-0.5 shrink-0 text-black dark:text-white"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-black dark:text-white">
              {t(`catalog.${entry.key}.name`)}
            </span>
            {isConnected && !needsReauth && (
              <span className="inline-flex items-center gap-1 rounded-sm bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:text-green-300">
                <IconCheck size={12} aria-hidden="true" />
                {t('connected')}
                {last4 && <> · {t('tokenEndsIn', { last4 })}</>}
              </span>
            )}
            {needsReauth && (
              <span className="inline-flex items-center gap-1 rounded-sm bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
                <IconAlertTriangle size={12} aria-hidden="true" />
                {t('needsReauth')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
            {t(`catalog.${entry.key}.description`)}
          </p>

          {error && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          {config ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-4">
                {!isLoadingTools && tools.length > 0 && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t('toolCount', { count: tools.length })}
                  </span>
                )}
                {needsReauth && canStartOauth && (
                  <button
                    type="button"
                    onClick={handleConnectOauth}
                    disabled={isBusy}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    {isBusy ? t('oauthWaiting') : t('reconnect')}
                  </button>
                )}
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-gray-600 dark:accent-gray-400"
                    checked={config.enabled}
                    onChange={(e) =>
                      updateMcpServer(config.id, { enabled: e.target.checked })
                    }
                  />
                  <span className="text-sm text-black dark:text-gray-200">
                    {t('enableServer')}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => deleteMcpServer(config.id)}
                  className="text-sm text-red-600 dark:text-red-400 hover:underline"
                >
                  {t('disconnect')}
                </button>
              </div>
              {needsReauth && !canStartOauth && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('oauthNoAppConfigured', { name: entry.label })}
                </p>
              )}
              {connectedViaOauth && (
                // No token revocation in v1 (RFC 7009 via the proxy is a
                // clean follow-up) — deleting only removes local access.
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('disconnectOauthNote', { name: entry.label })}
                  {config.oauthApp && <> {t('ownAppInUse')}</>}
                </p>
              )}
            </div>
          ) : oauthSupported && !expanded ? (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                {/* Hidden when there is no app to tie into: the click would
                    only round-trip to an oauth_unavailable error. */}
                {canStartOauth && (
                  <button
                    type="button"
                    onClick={handleConnectOauth}
                    disabled={isBusy}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isBusy
                      ? t('oauthWaiting')
                      : t('connectWithProvider', { name: entry.label })}
                  </button>
                )}
                {patAvailable && (
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {t('useTokenInstead')}
                  </button>
                )}
                {!ownAppForced && (
                  <button
                    type="button"
                    onClick={() => setShowOwnApp((v) => !v)}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {t('ownAppToggle')}
                  </button>
                )}
              </div>
              {!oauthAppAvailable && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('oauthNoAppConfigured', { name: entry.label })}
                </p>
              )}
              {showOwnAppFields && (
                <OwnOauthAppFields
                  providerName={entry.label}
                  clientId={ownClientId}
                  clientSecret={ownClientSecret}
                  onClientIdChange={setOwnClientId}
                  onClientSecretChange={setOwnClientSecret}
                />
              )}
            </div>
          ) : expanded ? (
            <div className="mt-3 space-y-2">
              <label className="block text-sm font-medium text-black dark:text-white">
                {t('patLabel')}
              </label>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setError(null);
                }}
                placeholder={entry.tokenPlaceholder}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('tokenScopeHint')}{' '}
                {entry.tokenHelpUrl && (
                  <a
                    href={entry.tokenHelpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {t('createTokenLink')}
                    <IconExternalLink size={12} aria-hidden="true" />
                  </a>
                )}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleConnectToken}
                  disabled={isBusy}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {isBusy ? t('validating') : t('connect')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(false);
                    setToken('');
                    setError(null);
                  }}
                  className="rounded-lg px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  {tCommon('cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              {t('connect')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

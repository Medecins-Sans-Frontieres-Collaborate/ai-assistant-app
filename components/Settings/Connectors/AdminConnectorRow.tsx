'use client';

import {
  IconAlertTriangle,
  IconBuildingBank,
  IconCheck,
  IconExternalLink,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { AvailableConnector } from '@/client/hooks/settings/useAvailableConnectors';
import { useMcpTools } from '@/client/hooks/settings/useMcpTools';

import { connectMcpOauth } from '@/client/services/mcp/mcpOauth';

import { ToolCountDisclosure } from './ToolCountDisclosure';
import { validateMcpServer } from './validateMcpServer';

import {
  McpServerConfig,
  useSettingsStore,
} from '@/client/stores/settingsStore';

interface AdminConnectorRowProps {
  connector: AvailableConnector;
  /** The saved config for this connector, if connected. */
  config?: McpServerConfig;
  /** See CuratedConnectorRow.onDismiss — the add-from-browser affordance. */
  onDismiss?: () => void;
}

/**
 * One admin-authored connector. Deliberately simpler than
 * CuratedConnectorRow: there is no "bring your own OAuth app" path, because
 * the administrator configures the app on the connector record itself — a
 * user supplying their own client would defeat the point of a tenant-managed
 * connector.
 *
 * Name and description come from DATA, not i18n keys: an admin types them,
 * so there is nothing to translate. Only the surrounding chrome is localized.
 *
 * The 'none' auth style connects with no credential at all, so it saves
 * immediately rather than showing an empty token field.
 */
export const AdminConnectorRow: FC<AdminConnectorRowProps> = ({
  connector,
  config,
  onDismiss,
}) => {
  const t = useTranslations('connectors');
  const tCommon = useTranslations('common');
  const addMcpServer = useSettingsStore((s) => s.addMcpServer);
  const updateMcpServer = useSettingsStore((s) => s.updateMcpServer);
  const deleteMcpServer = useSettingsStore((s) => s.deleteMcpServer);

  const [expanded, setExpanded] = useState(
    () => Boolean(onDismiss) && connector.authStyle === 'bearer',
  );
  const [token, setToken] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tools, isLoadingTools } = useMcpTools(config);

  const connectedViaOauth = config?.authMode === 'oauth';
  const needsReauth = !!config?.oauth?.needsReauth;
  const isConnected =
    !!config && (!connectedViaOauth || !!config.oauth?.accessToken);
  const last4 =
    !connectedViaOauth && config?.authToken ? config.authToken.slice(-4) : '';
  // An OAuth connector with no app configured on the record cannot start a
  // flow, and there is no user-supplied fallback — so say so instead of
  // offering a button that round-trips to an error.
  const canStartOauth =
    connector.authStyle === 'oauth' && connector.oauthAppConfigured;

  /** Shared shape for both connect paths — the URL is always server-resolved. */
  const baseConfig = {
    id: connector.id,
    connectorId: connector.id,
    name: connector.name,
    url: '',
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  const handleConnectToken = async () => {
    if (connector.authStyle === 'bearer' && !token.trim()) {
      setError(t('tokenRequired'));
      return;
    }
    setIsBusy(true);
    setError(null);
    const result = await validateMcpServer({
      id: connector.id,
      name: connector.name,
      connectorId: connector.id,
      ...(token.trim() ? { authToken: token.trim() } : {}),
    });
    setIsBusy(false);
    if (!result.ok) {
      setError(
        result.errorKind === 'auth' ? t('authFailed') : t('validationFailed'),
      );
      return;
    }
    addMcpServer({
      ...baseConfig,
      authMode: connector.authStyle === 'none' ? 'none' : 'bearer',
      ...(token.trim() ? { authToken: token.trim() } : {}),
    });
    setToken('');
    setExpanded(false);
  };

  const handleConnectOauth = async () => {
    setIsBusy(true);
    setError(null);
    try {
      const oauth = await connectMcpOauth(
        {
          id: connector.id,
          name: connector.name,
          connectorId: connector.id,
          // Reconnect reuses the client the flow registered last time.
        },
        config?.oauth?.clientId,
        config?.oauth?.clientSecret,
      );
      if (config) {
        updateMcpServer(config.id, {
          authMode: 'oauth',
          authToken: undefined,
          oauth,
          enabled: true,
        });
      } else {
        addMcpServer({ ...baseConfig, authMode: 'oauth', oauth });
      }
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

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-start gap-3">
        <IconBuildingBank
          size={24}
          className="mt-0.5 shrink-0 text-black dark:text-white"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-black dark:text-white">
              {connector.name}
            </span>
            <span className="rounded-sm bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300">
              {t('managedByOrg')}
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
          {connector.description && (
            <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
              {connector.description}
            </p>
          )}

          {error && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          {config ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-4">
                {!isLoadingTools && (
                  <ToolCountDisclosure
                    serverLabel={connector.name}
                    tools={tools}
                  />
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
              {connectedViaOauth && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('disconnectOauthNote', { name: connector.name })}
                </p>
              )}
            </div>
          ) : connector.authStyle === 'oauth' ? (
            <div className="mt-3 space-y-2">
              {canStartOauth ? (
                <button
                  type="button"
                  onClick={handleConnectOauth}
                  disabled={isBusy}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {isBusy
                    ? t('oauthWaiting')
                    : t('connectWithProvider', { name: connector.name })}
                </button>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('connectorOauthNotConfigured')}
                </p>
              )}
              {onDismiss && (
                <button
                  type="button"
                  onClick={onDismiss}
                  className="text-sm text-gray-600 dark:text-gray-400 hover:underline"
                >
                  {tCommon('cancel')}
                </button>
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
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none"
              />
              {connector.tokenHelpUrl && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('tokenScopeHint')}{' '}
                  <a
                    href={connector.tokenHelpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {t('createTokenLink')}
                    <IconExternalLink size={12} aria-hidden="true" />
                  </a>
                </p>
              )}
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
                    onDismiss?.();
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
              onClick={() =>
                connector.authStyle === 'none'
                  ? handleConnectToken()
                  : setExpanded(true)
              }
              disabled={isBusy}
              className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              {isBusy ? t('validating') : t('connect')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

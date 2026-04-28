'use client';

import {
  IconExternalLink,
  IconKey,
  IconShieldCheck,
} from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

export interface ConsentRequest {
  /** OAuth sign-in (user clicks link, re-sends message) or approval (developer must POST response — surfaced as info). */
  kind: 'oauth' | 'approval';
  /** OAuth sign-in URL — only for kind: 'oauth'. */
  consent_url?: string;
  /** Approval request id — only for kind: 'approval'. */
  approval_request_id?: string;
  /** MCP server / connector identifier (e.g. "NetSuite"). May be null. */
  server_label?: string | null;
  /** Tool/function name being invoked — only for kind: 'approval'. */
  tool_name?: string | null;
}

interface ConsentCardProps {
  request: ConsentRequest;
}

export const ConsentCard: FC<ConsentCardProps> = ({ request }) => {
  const t = useTranslations('chat.consent');
  const serverLabel = request.server_label?.trim() || null;

  if (request.kind === 'oauth' && request.consent_url) {
    return (
      <div className="my-3 rounded-xl border border-amber-200/80 bg-amber-50/60 dark:border-amber-700/40 dark:bg-amber-900/15 p-4 not-prose">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-amber-100 dark:bg-amber-900/40 p-2 shrink-0">
            <IconKey
              size={18}
              className="text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
              {serverLabel
                ? t('authorizeService', { service: serverLabel })
                : t('authorizeRequired')}
            </h4>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
              {serverLabel
                ? t('descriptionWithService', { service: serverLabel })
                : t('descriptionGeneric')}
            </p>
            <a
              href={request.consent_url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors"
            >
              {t('authorizeButton')}
              <IconExternalLink size={14} aria-hidden="true" />
            </a>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {t('resendHint')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (request.kind === 'approval') {
    return (
      <div className="my-3 rounded-xl border border-blue-200/80 bg-blue-50/60 dark:border-blue-700/40 dark:bg-blue-900/15 p-4 not-prose">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-blue-100 dark:bg-blue-900/40 p-2 shrink-0">
            <IconShieldCheck
              size={18}
              className="text-blue-700 dark:text-blue-300"
              aria-hidden="true"
            />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
              {serverLabel
                ? t('approvalForService', { service: serverLabel })
                : t('approvalRequired')}
            </h4>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
              {request.tool_name
                ? t('approvalDescriptionWithTool', { tool: request.tool_name })
                : t('approvalDescriptionGeneric')}
            </p>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {t('approvalNotImplementedHint')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

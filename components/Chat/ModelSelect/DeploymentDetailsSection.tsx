import {
  IconBox,
  IconMapPin,
  IconPlug,
  IconServer,
  IconTag,
  IconWorld,
} from '@tabler/icons-react';
import { FC, ReactNode } from 'react';

import { useTranslations } from 'next-intl';

import { OpenAIModel } from '@/types/openai';

import { FAMILY_LABEL } from './ModelFamilyFilter';

interface DeploymentDetailsSectionProps {
  /** The selected custom-source (byom) model. */
  selectedModel: OpenAIModel;
  /** Display name of the connected model source this model came from. */
  sourceName?: string;
}

/**
 * Account name + subscription id from an ARM account path
 * (/subscriptions/{sub}/resourceGroups/{rg}/.../accounts/{name}). Best-effort:
 * missing segments simply omit their row.
 */
function parseArmAccountPath(path: string | undefined): {
  accountName?: string;
  subscriptionId?: string;
} {
  if (!path) return {};
  return {
    subscriptionId: /\/subscriptions\/([^/]+)/i.exec(path)?.[1],
    accountName: /\/accounts\/([^/]+)/i.exec(path)?.[1],
  };
}

/**
 * Provenance panel for custom-source (byom) models: which connected source,
 * Azure account, region, and ARM deployment is behind the selected model.
 * Rendered in the details panel after the Variant/Version switchers; rows
 * with no value are omitted. Visual style mirrors ModelHeader's metadata
 * rows (small icon + text).
 */
export const DeploymentDetailsSection: FC<DeploymentDetailsSectionProps> = ({
  selectedModel,
  sourceName,
}) => {
  const t = useTranslations('modelSelect');

  const { accountName, subscriptionId } = parseArmAccountPath(
    selectedModel.modelSource,
  );
  const publisher = selectedModel.provider
    ? (FAMILY_LABEL[selectedModel.provider] ?? selectedModel.provider)
    : undefined;

  const rows: Array<{
    key: string;
    icon: ReactNode;
    label: string;
    value: ReactNode;
  }> = [];
  const addRow = (
    key: string,
    icon: ReactNode,
    value: ReactNode | undefined,
  ) => {
    if (value) rows.push({ key, icon, label: t(`deployment.${key}`), value });
  };

  addRow('source', <IconPlug size={14} aria-hidden="true" />, sourceName);
  addRow(
    'account',
    <IconServer size={14} aria-hidden="true" />,
    accountName &&
      (subscriptionId ? `${accountName} · ${subscriptionId}` : accountName),
  );
  // Raw Azure region strings (e.g. "swedencentral") are proper nouns — not
  // translated or prettified.
  addRow(
    'location',
    <IconMapPin size={14} aria-hidden="true" />,
    selectedModel.sourceLocation,
  );
  addRow(
    'deployment',
    <IconBox size={14} aria-hidden="true" />,
    selectedModel.deploymentName && (
      <span className="font-mono">{selectedModel.deploymentName}</span>
    ),
  );
  addRow(
    'modelVersion',
    <IconTag size={14} aria-hidden="true" />,
    selectedModel.deploymentModelVersion && (
      <span className="font-mono">{selectedModel.deploymentModelVersion}</span>
    ),
  );
  addRow('publisher', <IconWorld size={14} aria-hidden="true" />, publisher);

  if (rows.length === 0) return null;

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-1.5">
        {t('deployment.title')}
      </h4>
      <dl className="space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400"
          >
            <span className="shrink-0 text-gray-400 dark:text-gray-500">
              {row.icon}
            </span>
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">
              {row.label}
            </dt>
            <dd className="min-w-0 truncate text-gray-700 dark:text-gray-300">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

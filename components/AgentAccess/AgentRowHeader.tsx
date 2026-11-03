'use client';

import type { FC, ReactNode } from 'react';

import styles from './AgentRow.module.css';

interface AgentRowHeaderProps {
  identity: ReactNode;
  audience: ReactNode;
  actions: ReactNode;
}

/** Aligns identity, audience/status and actions using the list's actual width. */
export const AgentRowHeader: FC<AgentRowHeaderProps> = ({
  identity,
  audience,
  actions,
}) => (
  <div className={styles.header}>
    <div className="min-w-0 space-y-1">{identity}</div>
    <div className="min-w-0 space-y-1">{audience}</div>
    <div className={styles.actions}>{actions}</div>
  </div>
);

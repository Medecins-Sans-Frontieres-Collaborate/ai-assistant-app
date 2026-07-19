'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LDProvider } from 'launchdarkly-react-client-sdk';
import { SessionProvider } from 'next-auth/react';
import { ReactNode } from 'react';
import { Toaster } from 'react-hot-toast';

import { Session } from 'next-auth';

import { AgentAccessEnabledContext } from '@/client/hooks/settings/useAgentAccessAdmin';

import { UIPreferences } from '@/types/ui';

import { SessionErrorHandler } from '@/components/Auth/SessionErrorHandler';
import { UIPreferencesProvider } from '@/components/Providers/UIPreferencesProvider';
import TermsAcceptanceProvider from '@/components/Terms/TermsAcceptanceProvider';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

interface AppProvidersProps {
  children: ReactNode;
  session?: Session | null;
  launchDarklyClientId?: string;
  /**
   * Server-side AGENT_ACCESS_CONTROL_ENABLED, threaded down like
   * launchDarklyClientId. Gates the client /api/agent-access/me fetch so
   * nothing fires while the feature is disabled.
   */
  agentAccessEnabled?: boolean;
  userContext?: {
    id: string;
    email?: string;
    givenName?: string;
    surname?: string;
    displayName?: string;
    jobTitle?: string;
    department?: string;
    companyName?: string;
  };
  initialUIPreferences?: UIPreferences;
}

/**
 * Wrapper for all application providers
 * Composes: Session, React Query, LaunchDarkly, Terms, Toast
 */
export function AppProviders({
  children,
  session,
  launchDarklyClientId,
  agentAccessEnabled,
  userContext,
  initialUIPreferences,
}: AppProvidersProps) {
  return (
    <SessionProvider
      session={session}
      refetchInterval={5 * 60 * 1000}
      refetchOnWindowFocus={true}
    >
      <SessionErrorHandler />
      <QueryClientProvider client={queryClient}>
        <AgentAccessEnabledContext.Provider value={agentAccessEnabled ?? false}>
          <UIPreferencesProvider initialPreferences={initialUIPreferences}>
            {launchDarklyClientId ? (
              <LDProvider
                clientSideID={launchDarklyClientId}
                options={{
                  bootstrap: 'localStorage',
                  sendEvents: true,
                }}
                context={{
                  kind: 'user',
                  key: userContext?.id || 'anonymous-user',
                  email: userContext?.email,
                  givenName: userContext?.givenName,
                  surName: userContext?.surname,
                  displayName: userContext?.displayName,
                  jobTitle: userContext?.jobTitle,
                  department: userContext?.department,
                  companyName: userContext?.companyName,
                }}
              >
                <TermsAcceptanceProvider>
                  <Toaster position="top-center" />
                  {children}
                </TermsAcceptanceProvider>
              </LDProvider>
            ) : (
              <TermsAcceptanceProvider>
                <Toaster position="top-center" />
                {children}
              </TermsAcceptanceProvider>
            )}
          </UIPreferencesProvider>
        </AgentAccessEnabledContext.Provider>
      </QueryClientProvider>
    </SessionProvider>
  );
}

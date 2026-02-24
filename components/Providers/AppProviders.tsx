'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LDProvider } from 'launchdarkly-react-client-sdk';
import { SessionProvider } from 'next-auth/react';
import { ReactNode } from 'react';
import { Toaster } from 'react-hot-toast';

import { Session } from 'next-auth';

import { UIPreferences } from '@/types/ui';

import { CookieSizeGuard } from '@/components/Auth/CookieSizeGuard';
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
 * Composes: CookieSizeGuard, Session, React Query, LaunchDarkly, Terms, Toast
 *
 * CookieSizeGuard is placed outermost to detect oversized cookies before
 * any authenticated requests are made, preventing 431 HTTP errors.
 */
export function AppProviders({
  children,
  session,
  launchDarklyClientId,
  userContext,
  initialUIPreferences,
}: AppProvidersProps) {
  return (
    <CookieSizeGuard>
      <SessionProvider
        session={session}
        refetchInterval={5 * 60 * 1000}
        refetchOnWindowFocus={true}
      >
        <SessionErrorHandler />
        <QueryClientProvider client={queryClient}>
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
        </QueryClientProvider>
      </SessionProvider>
    </CookieSizeGuard>
  );
}

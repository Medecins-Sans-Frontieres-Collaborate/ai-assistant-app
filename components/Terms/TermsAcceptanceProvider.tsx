import { useSession } from 'next-auth/react';
import React, { FC, ReactNode, useEffect, useState } from 'react';

import { checkUserTermsAcceptance } from '@/lib/utils/app/user/termsAcceptance';

import TermsAcceptanceModal from './TermsAcceptanceModal';

/**
 * Props interface for the TermsAcceptanceProvider component.
 * @interface TermsAcceptanceProviderProps
 * @property {ReactNode} children - Child components to be rendered within the provider.
 */
interface TermsAcceptanceProviderProps {
  children: ReactNode;
}

/**
 * Provider component that manages the terms and conditions acceptance flow for EU users.
 * US-based users (region: 'US') are exempt from accepting terms.
 * Checks if the user has accepted the terms and shows a modal if they haven't.
 *
 * @component
 * @param {TermsAcceptanceProviderProps} props - Component props
 * @returns {ReactElement} The wrapped children with terms acceptance handling
 */
export const TermsAcceptanceProvider: FC<TermsAcceptanceProviderProps> = ({
  children,
}) => {
  const { data: session, status } = useSession();
  const [showTermsModal, setShowTermsModal] = useState<boolean>(false);
  const [checkingTerms, setCheckingTerms] = useState<boolean>(true);

  useEffect(() => {
    const checkTermsAcceptance = async () => {
      if (status === 'loading') return;

      // Check for force terms override (useful for testing or forcing re-acceptance)
      const forceTerms = process.env.NEXT_PUBLIC_FORCE_TERMS_MODAL === 'true';

      if (forceTerms && status === 'authenticated' && session?.user) {
        // Force show terms for all authenticated users, bypassing region and acceptance checks
        setShowTermsModal(true);
        setCheckingTerms(false);
        return;
      }

      // Only show terms for authenticated EU users (not US-based)
      if (
        status === 'authenticated' &&
        session?.user &&
        session.user.region !== 'US'
      ) {
        setCheckingTerms(true);
        try {
          const hasAcceptedTerms = await checkUserTermsAcceptance(session.user);
          setShowTermsModal(!hasAcceptedTerms);
        } catch (error) {
          console.error('Error checking terms acceptance:', error);
          setShowTermsModal(true);
        } finally {
          setCheckingTerms(false);
        }
      } else {
        setShowTermsModal(false);
        setCheckingTerms(false);
      }
    };

    checkTermsAcceptance();
  }, [session, status]);

  /**
   * Handles the acceptance of terms and conditions by the user.
   * Closes the terms acceptance modal.
   */
  const handleTermsAccepted = () => {
    setShowTermsModal(false);
  };

  // If checking terms or not authenticated yet, render children
  if (checkingTerms || status !== 'authenticated') {
    return <>{children}</>;
  }

  if (showTermsModal && session?.user) {
    return (
      <>
        {children}
        <TermsAcceptanceModal
          user={session.user}
          onAcceptance={handleTermsAccepted}
        />
      </>
    );
  }

  return <>{children}</>;
};

export default TermsAcceptanceProvider;

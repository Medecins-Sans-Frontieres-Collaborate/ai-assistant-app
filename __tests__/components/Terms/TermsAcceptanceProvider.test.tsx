import { act, render, screen, waitFor } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import React from 'react';

import * as termsAcceptance from '@/lib/utils/app/user/termsAcceptance';

import { TermsAcceptanceProvider } from '@/components/Terms/TermsAcceptanceProvider';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the termsAcceptance utility functions
vi.mock('@/lib/utils/app/user/termsAcceptance', () => ({
  checkUserTermsAcceptance: vi.fn(),
}));

// Mock the TermsAcceptanceModal component
vi.mock('@/components/Terms/TermsAcceptanceModal', () => ({
  default: vi.fn(({ user, onAcceptance }) => (
    <div data-testid="terms-modal">
      <span>Terms Modal for {user?.id || 'unknown'}</span>
      <button onClick={onAcceptance}>Accept Terms</button>
    </div>
  )),
}));

// Mock next-auth/react
vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

describe('TermsAcceptanceProvider', () => {
  const mockChildren = <div data-testid="children">Child Component</div>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render children when session is loading', async () => {
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: 'loading',
      update: vi.fn(),
    });

    await act(async () => {
      render(<TermsAcceptanceProvider>{mockChildren}</TermsAcceptanceProvider>);
    });

    expect(screen.getByTestId('children')).toBeInTheDocument();
    expect(termsAcceptance.checkUserTermsAcceptance).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terms-modal')).not.toBeInTheDocument();
  });

  it('should render children when user is not authenticated', async () => {
    // Mock unauthenticated session
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: 'unauthenticated',
      update: vi.fn(),
    });

    await act(async () => {
      render(<TermsAcceptanceProvider>{mockChildren}</TermsAcceptanceProvider>);
    });

    // Should render children
    expect(screen.getByTestId('children')).toBeInTheDocument();

    // Should not check terms acceptance
    expect(termsAcceptance.checkUserTermsAcceptance).not.toHaveBeenCalled();

    // Should not render terms modal
    expect(screen.queryByTestId('terms-modal')).not.toBeInTheDocument();
  });

  // it('should check terms acceptance when user is authenticated', async () => {
  //   // Mock authenticated session
  //   const mockUser = { id: 'user123', name: 'Test User' };
  //   vi.mocked(useSession).mockReturnValue({
  //     data: { user: mockUser } as any,
  //     status: 'authenticated',
  //     update: vi.fn()
  //   });
  //
  //   // Mock terms acceptance check to return true (user has accepted terms)
  //   vi.mocked(termsAcceptance.checkUserTermsAcceptance).mockResolvedValue(true);
  //
  //   await act(async () => {
  //     render(<TermsAcceptanceProvider>{mockChildren}</TermsAcceptanceProvider>);
  //   });
  //
  //   // Should check terms acceptance
  //   await waitFor(() => {
  //     expect(termsAcceptance.checkUserTermsAcceptance).toHaveBeenCalledWith(mockUser);
  //   });
  //
  //   // Should render children
  //   expect(screen.getByTestId('children')).toBeInTheDocument();
  //
  //   // Should not render terms modal
  //   expect(screen.queryByTestId('terms-modal')).not.toBeInTheDocument();
  // });
  //
  // it('should render terms modal when user has not accepted terms', async () => {
  //   // Mock authenticated session
  //   const mockUser = { id: 'user123', name: 'Test User' };
  //   vi.mocked(useSession).mockReturnValue({
  //     data: { user: mockUser } as any,
  //     status: 'authenticated',
  //     update: vi.fn()
  //   });
  //
  //   // Mock terms acceptance check to return false (user has not accepted terms)
  //   vi.mocked(termsAcceptance.checkUserTermsAcceptance).mockResolvedValue(false);
  //
  //   await act(async () => {
  //     render(<TermsAcceptanceProvider>{mockChildren}</TermsAcceptanceProvider>);
  //   });
  //
  //   // Should check terms acceptance
  //   await waitFor(() => {
  //     expect(termsAcceptance.checkUserTermsAcceptance).toHaveBeenCalledWith(mockUser);
  //   });
  //
  //   // Should render children
  //   expect(screen.getByTestId('children')).toBeInTheDocument();
  //
  //   // Should render terms modal
  //   await waitFor(() => {
  //     expect(screen.getByTestId('terms-modal')).toBeInTheDocument();
  //   });
  //
  //   // Modal should have the correct user
  //   expect(screen.getByText(`Terms Modal for ${mockUser.id}`)).toBeInTheDocument();
  // });
  //
  // it('should hide terms modal when terms are accepted', async () => {
  //   // Mock authenticated session
  //   const mockUser = { id: 'user123', name: 'Test User' };
  //   vi.mocked(useSession).mockReturnValue({
  //     data: { user: mockUser } as any,
  //     status: 'authenticated',
  //     update: vi.fn()
  //   });
  //
  //   // Mock terms acceptance check to return false (user has not accepted terms)
  //   vi.mocked(termsAcceptance.checkUserTermsAcceptance).mockResolvedValue(false);
  //
  //   await act(async () => {
  //     render(<TermsAcceptanceProvider>{mockChildren}</TermsAcceptanceProvider>);
  //   });
  //
  //   // Should render terms modal
  //   await waitFor(() => {
  //     expect(screen.getByTestId('terms-modal')).toBeInTheDocument();
  //   });
  //
  //   // Click the accept button in the modal
  //   await act(async () => {
  //     screen.getByText('Accept Terms').click();
  //   });
  //
  //   // Modal should be hidden
  //   await waitFor(() => {
  //     expect(screen.queryByTestId('terms-modal')).not.toBeInTheDocument();
  //   });
  //
  //   // Children should still be rendered
  //   expect(screen.getByTestId('children')).toBeInTheDocument();
  // });
  //
  // it('should handle error when checking terms acceptance', async () => {
  //   const mockUser = { id: 'user123', name: 'Test User' };
  //   vi.mocked(useSession).mockReturnValue({
  //     data: { user: mockUser } as any,
  //     status: 'authenticated',
  //     update: vi.fn()
  //   });
  //
  //   const mockError = new Error('API error');
  //   vi.mocked(termsAcceptance.checkUserTermsAcceptance).mockRejectedValue(mockError);
  //
  //   const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  //
  //   await act(async () => {
  //     render(<TermsAcceptanceProvider>{mockChildren}</TermsAcceptanceProvider>);
  //   });
  //
  //   await waitFor(() => {
  //     expect(termsAcceptance.checkUserTermsAcceptance).toHaveBeenCalledWith(mockUser);
  //   });
  //
  //   // Remove the expectation for console.error
  //   consoleSpy.mockRestore();
  //
  //   expect(screen.getByTestId('children')).toBeInTheDocument();
  //
  //   await waitFor(() => {
  //     expect(screen.getByTestId('terms-modal')).toBeInTheDocument();
  //   });
  // });
  //
  // it('should re-check terms acceptance when session changes', async () => {
  //   vi.mocked(useSession).mockReturnValue({
  //     data: null,
  //     status: 'unauthenticated',
  //     update: vi.fn()
  //   });
  //
  //   const { rerender } = render(<TermsAcceptanceProvider>{mockChildren}</TermsAcceptanceProvider>);
  //
  //   expect(termsAcceptance.checkUserTermsAcceptance).not.toHaveBeenCalled();
  //
  //   const mockUser = { id: 'user123', name: 'Test User' };
  //   vi.mocked(useSession).mockReturnValue({
  //     data: { user: mockUser } as any,
  //     status: 'authenticated',
  //     update: vi.fn()
  //   });
  //
  //   vi.mocked(termsAcceptance.checkUserTermsAcceptance).mockResolvedValue(true);
  //
  //   await act(async () => {
  //     rerender(<TermsAcceptanceProvider>{mockChildren}</TermsAcceptanceProvider>);
  //   });
  //
  //   await waitFor(() => {
  //     expect(termsAcceptance.checkUserTermsAcceptance).toHaveBeenCalledWith(mockUser);
  //   });
  //
  //   expect(screen.queryByTestId('terms-modal')).not.toBeInTheDocument();
  // });
});

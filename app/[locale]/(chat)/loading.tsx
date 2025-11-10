import { LoadingScreen } from '@/components/Chat/LoadingScreen';

/**
 * Route-level loading UI
 * Automatically wraps page.tsx in a Suspense boundary
 * Shown during navigation and initial page load
 */
export default function Loading() {
  return <LoadingScreen />;
}

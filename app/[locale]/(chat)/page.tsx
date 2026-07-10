'use client';

import { Suspense, useState } from 'react';

import { useSelectedConversationType } from '@/client/hooks/workflows/useSelectedConversationType';

import { Chat } from '@/components/Chat/Chat';
import { LoadingScreen } from '@/components/Chat/LoadingScreen';
import { MobileChatHeader } from '@/components/Chat/MobileChatHeader';
import { WorkflowShell } from '@/components/Workflows/WorkflowShell';

/**
 * Main chat page
 * Client component - entire page is interactive
 * Sidebar and layout are in ChatLayoutClient to prevent remounting
 *
 * Workflow conversations (conversationType set) render the specialized
 * WorkflowShell instead of the standard chat surface. The branch reads the
 * conversation's type, not the LaunchDarkly flag, so existing workflow
 * conversations always open even when the flag is off.
 */
export default function ChatPage() {
  const [isModelSelectOpen, setIsModelSelectOpen] = useState(false);
  const workflowType = useSelectedConversationType();

  if (workflowType) {
    return (
      <div className="flex flex-1 overflow-hidden">
        <Suspense fallback={<LoadingScreen />}>
          <WorkflowShell />
        </Suspense>
      </div>
    );
  }

  return (
    <>
      <MobileChatHeader onModelSelectChange={setIsModelSelectOpen} />

      <div className="flex flex-1 pt-14 md:pt-0">
        <Suspense fallback={<LoadingScreen />}>
          <Chat
            mobileModelSelectOpen={isModelSelectOpen}
            onMobileModelSelectChange={setIsModelSelectOpen}
          />
        </Suspense>
      </div>
    </>
  );
}

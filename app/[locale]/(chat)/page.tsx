'use client';

import { Suspense, useState } from 'react';

import { useSelectedConversationType } from '@/client/hooks/workflows/useSelectedConversationType';

import { Chat } from '@/components/Chat/Chat';
import { LoadingScreen } from '@/components/Chat/LoadingScreen';
import { MobileChatHeader } from '@/components/Chat/MobileChatHeader';
import { FolderView } from '@/components/Folders/FolderView';
import { WorkflowShell } from '@/components/Workflows/WorkflowShell';

import { useUIStore } from '@/client/stores/uiStore';

/**
 * Main chat page
 * Client component - entire page is interactive
 * Sidebar and layout are in ChatLayoutClient to prevent remounting
 *
 * Workflow conversations (conversationType set) render the specialized
 * WorkflowShell instead of the standard chat surface. The branch reads the
 * conversation's type, not the LaunchDarkly flag, so existing workflow
 * conversations always open even when the flag is off.
 *
 * A folder opened from the sidebar (uiStore.openFolderId) takes precedence
 * and renders the FolderView; it is ephemeral state that any conversation
 * selection clears, so the chat/workflow branch below is unaffected by it
 * once the user opens a chat.
 */
export default function ChatPage() {
  const [isModelSelectOpen, setIsModelSelectOpen] = useState(false);
  const workflowType = useSelectedConversationType();
  const openFolderId = useUIStore((s) => s.openFolderId);

  if (openFolderId) {
    return (
      <div className="flex flex-1 overflow-hidden">
        <FolderView folderId={openFolderId} />
      </div>
    );
  }

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

      {/* min-w-0: as a flex item this defaults to min-width:auto, so it
          refused to shrink below the composer's min-content width (~652px)
          and overflowed the viewport on narrow screens. */}
      <div className="flex min-w-0 flex-1 pt-14 md:pt-0">
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

'use client';

import { Suspense, useState } from 'react';

import { Chat } from '@/components/Chat/Chat';
import { LoadingScreen } from '@/components/Chat/LoadingScreen';
import { MobileChatHeader } from '@/components/Chat/MobileChatHeader';

/**
 * Main chat page
 * Client component - entire page is interactive
 * Sidebar and layout are in ChatLayoutClient to prevent remounting
 */
export default function ChatPage() {
  const [isModelSelectOpen, setIsModelSelectOpen] = useState(false);

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

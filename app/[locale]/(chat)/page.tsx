'use client';

import { Suspense, useCallback, useState } from 'react';

import { Chat } from '@/components/Chat/Chat';
import { LoadingScreen } from '@/components/Chat/LoadingScreen';
import { MobileChatHeader } from '@/components/Chat/MobileChatHeader';
import { WelcomeBanner } from '@/components/Chat/WelcomeBanner';

/**
 * Main chat page
 * Client component - entire page is interactive
 * Sidebar and layout are in ChatLayoutClient to prevent remounting
 */
export default function ChatPage() {
  const [isModelSelectOpen, setIsModelSelectOpen] = useState(false);
  const [isBannerVisible, setIsBannerVisible] = useState(false);

  const handleBannerVisibilityChange = useCallback((visible: boolean) => {
    setIsBannerVisible(visible);
  }, []);

  return (
    <>
      <WelcomeBanner onVisibilityChange={handleBannerVisibilityChange} />
      <MobileChatHeader
        onModelSelectChange={setIsModelSelectOpen}
        bannerVisible={isBannerVisible}
      />

      <div
        className={`flex flex-1 transition-all duration-300 ${isBannerVisible ? 'pt-[88px] md:pt-10' : 'pt-14 md:pt-0'}`}
      >
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

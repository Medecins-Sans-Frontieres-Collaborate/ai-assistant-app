import { FC, memo } from 'react';

import { ChatMessage, Props } from './ChatMessage';

export const MemoizedChatMessage: FC<Props> = memo(
  ChatMessage,
  (prevProps, nextProps) =>
    prevProps.message.content === nextProps.message.content &&
    // Digest cards patch state without touching content; every patch is a
    // new object, so reference equality is the right check.
    prevProps.message.digest === nextProps.message.digest &&
    prevProps.versionInfo?.current === nextProps.versionInfo?.current &&
    prevProps.versionInfo?.total === nextProps.versionInfo?.total,
);

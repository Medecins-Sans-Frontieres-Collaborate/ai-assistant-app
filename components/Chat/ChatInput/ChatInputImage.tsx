import React, {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useImperativeHandle,
  useRef,
} from 'react';

import { useTranslations } from 'next-intl';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
  ImageFieldValue,
} from '@/types/chat';

import ImageIcon from '@/components/Icons/image';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';

const onImageUploadButtonClick = (
  event: React.MouseEvent<HTMLButtonElement>,
  fileInputRef: MutableRefObject<HTMLInputElement | null>,
) => {
  event.preventDefault();
  fileInputRef.current?.click();
};

export interface ChatInputImageProps {
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>;
  prompt: string;
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setImageFieldValue: Dispatch<SetStateAction<ImageFieldValue>>;
  setUploadProgress: Dispatch<SetStateAction<{ [p: string]: number }>>;
  setParentModalIsOpen: Dispatch<SetStateAction<boolean>>;
  simulateClick?: boolean;
  labelText?: string;
  imageInputRef?: React.RefObject<{ openFilePicker: () => void } | null>;
}

const ChatInputImage = ({
  setSubmitType,
  prompt,
  setFilePreviews,
  setFileFieldValue,
  setImageFieldValue,
  setUploadProgress,
  setParentModalIsOpen,
  labelText,
  imageInputRef,
}: ChatInputImageProps) => {
  const t = useTranslations('chatInput');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(imageInputRef, () => ({
    openFilePicker: () => {
      fileInputRef.current?.click();
    },
  }));

  const openModalButtonRef: MutableRefObject<any> = useRef(null);

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={(event) => {
          onFileUpload(
            event,
            setSubmitType,
            setFilePreviews,
            setFileFieldValue,
            setImageFieldValue,
            setUploadProgress,
          );
          setParentModalIsOpen(false);
        }}
        accept={'image/*'}
      />
      <button
        style={{ display: 'none' }}
        onClick={(e) => {
          onImageUploadButtonClick(e, fileInputRef);
        }}
        ref={openModalButtonRef}
        className="flex items-center w-full text-right hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none"
      >
        <ImageIcon className="text-black dark:text-white mr-2 rounded h-5 w-5 hover:bg-gray-200 dark:hover:bg-gray-700" />
        <span className="text-black dark:text-white">
          {labelText ?? t('images')}
        </span>

        <span className="sr-only">{t('addImage')}</span>
      </button>
    </>
  );
};

export default ChatInputImage;

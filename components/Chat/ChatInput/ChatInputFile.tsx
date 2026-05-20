import React, {
  ChangeEvent,
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useRef,
} from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
} from '@/types/chat';

import FileIcon from '@/components/Icons/file';

interface ChatInputFileProps {
  onFileUpload: (
    event: React.ChangeEvent<any>,
    setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>,
    setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>,
    setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>,
    setImageFieldValue: Dispatch<SetStateAction<FileFieldValue>>,
    setUploadProgress: Dispatch<SetStateAction<{ [key: string]: number }>>,
  ) => void;
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>;
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setImageFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setUploadProgress: Dispatch<SetStateAction<{ [key: string]: number }>>;
}

const ChatInputFile = ({
  onFileUpload,
  setSubmitType,
  setFilePreviews,
  setFileFieldValue,
  setImageFieldValue,
  setUploadProgress,
}: ChatInputFileProps) => {
  const t = useTranslations('chatInput');
  const fileInputRef: MutableRefObject<any> = useRef(null);

  const handleFileButtonClick = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    try {
      if (fileInputRef.current) {
        fileInputRef.current.click();
      } else {
        console.error('File input reference is not available');
        toast.error(t('filePickerError'));
      }
    } catch (error) {
      console.error('Error triggering file input:', error);
      toast.error(t('filePickerError'));
    }
  };

  return (
    <>
      <input
        type="file"
        multiple
        ref={fileInputRef}
        className="opacity-0 absolute w-px h-px overflow-hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          event.preventDefault();
          onFileUpload(
            event,
            setSubmitType,
            setFilePreviews,
            setFileFieldValue,
            setImageFieldValue,
            setUploadProgress,
          );
        }}
      />
      <div className="relative group">
        <button onClick={handleFileButtonClick} className="flex">
          <FileIcon className="text-black dark:text-white rounded h-5 w-5 hover:bg-gray-200 dark:hover:bg-gray-700" />
          <span className="sr-only">{t('addDocument')}</span>
        </button>
        <div className="absolute left-1/2 transform -translate-x-1/2 bottom-full mb-2 hidden group-hover:block bg-black text-white text-xs py-1 px-2 rounded shadow-md">
          {t('uploadDocument')}
        </div>
      </div>
    </>
  );
};

export default ChatInputFile;

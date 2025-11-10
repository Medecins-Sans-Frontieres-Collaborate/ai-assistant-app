import { act, renderHook } from '@testing-library/react';

import { useUploadState } from '@/client/hooks/ui/useUploadState';

import { FilePreview } from '@/types/chat';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the file upload handler
vi.mock('@/client/handlers/chatInput/file-upload', () => ({
  onFileUpload: vi.fn(),
}));

describe('useUploadState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial State', () => {
    it('initializes with empty file previews', () => {
      const { result } = renderHook(() => useUploadState());

      expect(result.current.filePreviews).toEqual([]);
    });

    it('initializes with null file field value', () => {
      const { result } = renderHook(() => useUploadState());

      expect(result.current.fileFieldValue).toBeNull();
    });

    it('initializes with null image field value', () => {
      const { result } = renderHook(() => useUploadState());

      expect(result.current.imageFieldValue).toBeNull();
    });

    it('initializes with empty upload progress', () => {
      const { result } = renderHook(() => useUploadState());

      expect(result.current.uploadProgress).toEqual({});
    });

    it('initializes with text submit type', () => {
      const { result } = renderHook(() => useUploadState());

      expect(result.current.submitType).toBe('TEXT');
    });
  });

  describe('State Setters', () => {
    it('setFilePreviews updates file previews', () => {
      const { result } = renderHook(() => useUploadState());

      const mockPreviews: FilePreview[] = [
        {
          name: 'test.pdf',
          type: 'application/pdf',
          status: 'pending',
          previewUrl: 'base64string',
        },
      ];

      act(() => {
        result.current.setFilePreviews(mockPreviews);
      });

      expect(result.current.filePreviews).toEqual(mockPreviews);
    });

    it('setFileFieldValue updates file field value', () => {
      const { result } = renderHook(() => useUploadState());

      const mockValue = { name: 'test.pdf', size: 1024 };

      act(() => {
        result.current.setFileFieldValue(mockValue as any);
      });

      expect(result.current.fileFieldValue).toEqual(mockValue);
    });

    it('setImageFieldValue updates image field value', () => {
      const { result } = renderHook(() => useUploadState());

      const mockValue = { name: 'image.png', size: 2048 };

      act(() => {
        result.current.setImageFieldValue(mockValue as any);
      });

      expect(result.current.imageFieldValue).toEqual(mockValue);
    });

    it('setUploadProgress updates upload progress', () => {
      const { result } = renderHook(() => useUploadState());

      const mockProgress = { 'file-1': 50, 'file-2': 75 };

      act(() => {
        result.current.setUploadProgress(mockProgress);
      });

      expect(result.current.uploadProgress).toEqual(mockProgress);
    });

    it('setSubmitType updates submit type', () => {
      const { result } = renderHook(() => useUploadState());

      act(() => {
        result.current.setSubmitType('FILE');
      });

      expect(result.current.submitType).toBe('FILE');
    });
  });

  describe('clearUploadState', () => {
    it('clears all upload state', () => {
      const { result } = renderHook(() => useUploadState());

      // Set some state
      act(() => {
        result.current.setFilePreviews([
          {
            name: 'test.pdf',
            type: 'application/pdf',
            status: 'pending',
            previewUrl: 'base64',
          },
        ]);
        result.current.setFileFieldValue({ name: 'test.pdf' } as any);
        result.current.setImageFieldValue({ name: 'image.png' } as any);
        result.current.setUploadProgress({ 'file-1': 50 });
        result.current.setSubmitType('FILE');
      });

      // Verify state is set
      expect(result.current.filePreviews.length).toBe(1);
      expect(result.current.fileFieldValue).not.toBeNull();
      expect(result.current.imageFieldValue).not.toBeNull();
      expect(Object.keys(result.current.uploadProgress).length).toBe(1);
      expect(result.current.submitType).toBe('FILE');

      // Clear state
      act(() => {
        result.current.clearUploadState();
      });

      // Verify all state is cleared
      expect(result.current.filePreviews).toEqual([]);
      expect(result.current.fileFieldValue).toBeNull();
      expect(result.current.imageFieldValue).toBeNull();
      expect(result.current.uploadProgress).toEqual({});
      expect(result.current.submitType).toBe('TEXT');
    });

    it('can be called multiple times safely', () => {
      const { result } = renderHook(() => useUploadState());

      act(() => {
        result.current.clearUploadState();
        result.current.clearUploadState();
        result.current.clearUploadState();
      });

      expect(result.current.filePreviews).toEqual([]);
      expect(result.current.submitType).toBe('TEXT');
    });
  });

  describe('handleFileUpload', () => {
    it('is a function', () => {
      const { result } = renderHook(() => useUploadState());

      expect(typeof result.current.handleFileUpload).toBe('function');
    });

    it('calls onFileUpload with correct arguments', async () => {
      const { onFileUpload } = await import(
        '@/client/handlers/chatInput/file-upload'
      );
      const { result } = renderHook(() => useUploadState());

      const mockEvent = { target: { files: [] } } as any;

      await act(async () => {
        await result.current.handleFileUpload(mockEvent);
      });

      expect(onFileUpload).toHaveBeenCalledWith(
        mockEvent,
        expect.any(Function), // setSubmitType
        expect.any(Function), // setFilePreviews
        expect.any(Function), // setFileFieldValue
        expect.any(Function), // setImageFieldValue
        expect.any(Function), // setUploadProgress
      );
    });
  });

  describe('Callback Stability', () => {
    it('handleFileUpload reference is stable', () => {
      const { result, rerender } = renderHook(() => useUploadState());

      const firstRef = result.current.handleFileUpload;

      rerender();

      const secondRef = result.current.handleFileUpload;

      expect(firstRef).toBe(secondRef);
    });

    it('clearUploadState reference is stable', () => {
      const { result, rerender } = renderHook(() => useUploadState());

      const firstRef = result.current.clearUploadState;

      rerender();

      const secondRef = result.current.clearUploadState;

      expect(firstRef).toBe(secondRef);
    });
  });

  describe('Return Value Structure', () => {
    it('returns all expected properties', () => {
      const { result } = renderHook(() => useUploadState());

      const expectedProperties = [
        'filePreviews',
        'setFilePreviews',
        'fileFieldValue',
        'setFileFieldValue',
        'imageFieldValue',
        'setImageFieldValue',
        'uploadProgress',
        'setUploadProgress',
        'submitType',
        'setSubmitType',
        'handleFileUpload',
        'clearUploadState',
      ];

      expectedProperties.forEach((prop) => {
        expect(result.current).toHaveProperty(prop);
      });
    });
  });

  describe('Multiple File Previews', () => {
    it('handles multiple file previews', () => {
      const { result } = renderHook(() => useUploadState());

      const mockPreviews: FilePreview[] = [
        {
          name: 'file1.pdf',
          type: 'application/pdf',
          status: 'pending',
          previewUrl: 'base64-1',
        },
        {
          name: 'file2.pdf',
          type: 'application/pdf',
          status: 'pending',
          previewUrl: 'base64-2',
        },
        {
          name: 'file3.pdf',
          type: 'application/pdf',
          status: 'pending',
          previewUrl: 'base64-3',
        },
      ];

      act(() => {
        result.current.setFilePreviews(mockPreviews);
      });

      expect(result.current.filePreviews).toHaveLength(3);
      expect(result.current.filePreviews).toEqual(mockPreviews);
    });

    it('can add file previews incrementally', () => {
      const { result } = renderHook(() => useUploadState());

      const preview1: FilePreview = {
        name: 'file1.pdf',
        type: 'application/pdf',
        status: 'pending',
        previewUrl: 'base64-1',
      };

      act(() => {
        result.current.setFilePreviews([preview1]);
      });

      expect(result.current.filePreviews).toHaveLength(1);

      const preview2: FilePreview = {
        name: 'file2.pdf',
        type: 'application/pdf',
        status: 'pending',
        previewUrl: 'base64-2',
      };

      act(() => {
        result.current.setFilePreviews((prev) => [...prev, preview2]);
      });

      expect(result.current.filePreviews).toHaveLength(2);
    });
  });

  describe('Upload Progress Tracking', () => {
    it('tracks progress for multiple files', () => {
      const { result } = renderHook(() => useUploadState());

      act(() => {
        result.current.setUploadProgress({
          'file-1': 25,
          'file-2': 50,
          'file-3': 75,
        });
      });

      expect(result.current.uploadProgress['file-1']).toBe(25);
      expect(result.current.uploadProgress['file-2']).toBe(50);
      expect(result.current.uploadProgress['file-3']).toBe(75);
    });

    it('updates progress for individual files', () => {
      const { result } = renderHook(() => useUploadState());

      act(() => {
        result.current.setUploadProgress({ 'file-1': 0 });
      });

      act(() => {
        result.current.setUploadProgress((prev) => ({
          ...prev,
          'file-1': 50,
        }));
      });

      expect(result.current.uploadProgress['file-1']).toBe(50);

      act(() => {
        result.current.setUploadProgress((prev) => ({
          ...prev,
          'file-1': 100,
        }));
      });

      expect(result.current.uploadProgress['file-1']).toBe(100);
    });
  });

  describe('Submit Type Changes', () => {
    it('handles all submit types', () => {
      const { result } = renderHook(() => useUploadState());

      const submitTypes: Array<'TEXT' | 'FILE' | 'IMAGE'> = [
        'TEXT',
        'FILE',
        'IMAGE',
      ];

      submitTypes.forEach((type) => {
        act(() => {
          result.current.setSubmitType(type);
        });

        expect(result.current.submitType).toBe(type);
      });
    });
  });
});

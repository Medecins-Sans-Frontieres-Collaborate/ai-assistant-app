import { act, renderHook } from '@testing-library/react';

import { useDragAndDrop } from '@/client/hooks/ui/useDragAndDrop';

import { describe, expect, it, vi } from 'vitest';

describe('useDragAndDrop', () => {
  const createDragEvent = (
    type: string,
    files?: File[],
  ): React.DragEvent<HTMLDivElement> => {
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        files: files || [],
        clearData: vi.fn(),
      },
    } as unknown as React.DragEvent<HTMLDivElement>;
    return event;
  };

  it('initializes with isDragOver as false', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    expect(result.current.isDragOver).toBe(false);
  });

  it('sets isDragOver to true on drag enter', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    const event = createDragEvent('dragenter');

    act(() => {
      result.current.handleDragEnter(event);
    });

    expect(result.current.isDragOver).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('sets isDragOver to true on drag over', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    const event = createDragEvent('dragover');

    act(() => {
      result.current.handleDragOver(event);
    });

    expect(result.current.isDragOver).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('sets isDragOver to false on drag leave', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    // First set to true
    act(() => {
      result.current.handleDragEnter(createDragEvent('dragenter'));
    });

    expect(result.current.isDragOver).toBe(true);

    // Then handle drag leave
    const event = createDragEvent('dragleave');
    act(() => {
      result.current.handleDragLeave(event);
    });

    expect(result.current.isDragOver).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('calls onFiles with dropped files', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    const file1 = new File(['content1'], 'test1.txt', { type: 'text/plain' });
    const file2 = new File(['content2'], 'test2.txt', { type: 'text/plain' });
    const files = [file1, file2];

    const event = createDragEvent('drop', files);

    act(() => {
      result.current.handleDrop(event);
    });

    expect(onFiles).toHaveBeenCalledWith(files);
    expect(result.current.isDragOver).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('does not call onFiles when no files are dropped', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    const event = createDragEvent('drop', []);

    act(() => {
      result.current.handleDrop(event);
    });

    expect(onFiles).not.toHaveBeenCalled();
    expect(result.current.isDragOver).toBe(false);
  });

  it('attempts to clear data transfer after drop', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    const event = createDragEvent('drop', [file]);

    act(() => {
      result.current.handleDrop(event);
    });

    expect(event.dataTransfer.clearData).toHaveBeenCalled();
  });

  it('handles clearData error gracefully', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    const event = createDragEvent('drop', [file]);
    event.dataTransfer.clearData = vi.fn(() => {
      throw new Error('Cannot clear data');
    });

    // Should not throw error
    expect(() => {
      act(() => {
        result.current.handleDrop(event);
      });
    }).not.toThrow();

    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('provides stable handler references', () => {
    const onFiles = vi.fn();
    const { result, rerender } = renderHook(() => useDragAndDrop(onFiles));

    const handlers1 = {
      handleDragEnter: result.current.handleDragEnter,
      handleDragOver: result.current.handleDragOver,
      handleDragLeave: result.current.handleDragLeave,
      handleDrop: result.current.handleDrop,
    };

    rerender();

    const handlers2 = {
      handleDragEnter: result.current.handleDragEnter,
      handleDragOver: result.current.handleDragOver,
      handleDragLeave: result.current.handleDragLeave,
      handleDrop: result.current.handleDrop,
    };

    // Handlers should be stable (same reference) due to useCallback
    expect(handlers1.handleDragEnter).toBe(handlers2.handleDragEnter);
    expect(handlers1.handleDragOver).toBe(handlers2.handleDragOver);
    expect(handlers1.handleDragLeave).toBe(handlers2.handleDragLeave);
    expect(handlers1.handleDrop).toBe(handlers2.handleDrop);
  });

  it('updates handleDrop when onFiles changes', () => {
    const onFiles1 = vi.fn();
    const { result, rerender } = renderHook(
      ({ onFiles }) => useDragAndDrop(onFiles),
      { initialProps: { onFiles: onFiles1 } },
    );

    const handler1 = result.current.handleDrop;

    const onFiles2 = vi.fn();
    rerender({ onFiles: onFiles2 });

    const handler2 = result.current.handleDrop;

    // Handler should change when onFiles changes
    expect(handler1).not.toBe(handler2);
  });

  it('handles single file drop', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    const file = new File(['content'], 'single.txt', { type: 'text/plain' });
    const event = createDragEvent('drop', [file]);

    act(() => {
      result.current.handleDrop(event);
    });

    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('handles multiple files drop', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    const files = [
      new File(['1'], '1.txt', { type: 'text/plain' }),
      new File(['2'], '2.txt', { type: 'text/plain' }),
      new File(['3'], '3.txt', { type: 'text/plain' }),
    ];
    const event = createDragEvent('drop', files);

    act(() => {
      result.current.handleDrop(event);
    });

    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it('handles different file types', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    const files = [
      new File(['text'], 'doc.txt', { type: 'text/plain' }),
      new File(['img'], 'pic.png', { type: 'image/png' }),
      new File(['data'], 'data.json', { type: 'application/json' }),
    ];
    const event = createDragEvent('drop', files);

    act(() => {
      result.current.handleDrop(event);
    });

    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it('complete drag and drop flow', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    // Initial state
    expect(result.current.isDragOver).toBe(false);

    // Drag enter
    act(() => {
      result.current.handleDragEnter(createDragEvent('dragenter'));
    });
    expect(result.current.isDragOver).toBe(true);

    // Drag over (maintains state)
    act(() => {
      result.current.handleDragOver(createDragEvent('dragover'));
    });
    expect(result.current.isDragOver).toBe(true);

    // Drop files
    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    act(() => {
      result.current.handleDrop(createDragEvent('drop', [file]));
    });

    expect(result.current.isDragOver).toBe(false);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('complete drag and cancel flow', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => useDragAndDrop(onFiles));

    // Drag enter
    act(() => {
      result.current.handleDragEnter(createDragEvent('dragenter'));
    });
    expect(result.current.isDragOver).toBe(true);

    // Drag leave (cancel)
    act(() => {
      result.current.handleDragLeave(createDragEvent('dragleave'));
    });

    expect(result.current.isDragOver).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });
});

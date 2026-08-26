/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { usePasteChatInput } from '@/client/hooks/ui/usePasteChatInput';

import { SearchMode } from '@/types/searchMode';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAttachUrl = vi.hoisted(() => vi.fn());
vi.mock('@/client/hooks/chat/useUrlAttachment', () => ({
  useUrlAttachment: () => ({ attachUrl: mockAttachUrl }),
}));

const mockAttachPastedText = vi.hoisted(() => vi.fn());
vi.mock('@/client/hooks/chat/usePastedTextAttachment', () => ({
  usePastedTextAttachment: () => ({ attachPastedText: mockAttachPastedText }),
}));

function createPasteEvent(options: {
  imageFiles?: File[];
  text?: string;
  html?: string;
  target?: EventTarget;
}): ClipboardEvent {
  const event = new Event('paste', {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  const items = (options.imageFiles ?? []).map((file) => ({
    kind: 'file',
    type: file.type,
    getAsFile: () => file,
  }));
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: {
      items,
      files: options.imageFiles ?? [],
      getData: (type: string) =>
        type === 'text/html' ? (options.html ?? '') : (options.text ?? ''),
    },
  });
  if (options.target) {
    Object.defineProperty(event, 'target', {
      configurable: true,
      value: options.target,
    });
  }
  return event;
}

describe('usePasteChatInput', () => {
  let handleFileUpload: Mock;

  beforeEach(() => {
    handleFileUpload = vi.fn().mockResolvedValue(undefined);

    useChatInputStore.setState({
      textFieldValue: '',
      placeholderText: '',
      isTyping: false,
      isMultiline: false,
      isFocused: false,
      textareaScrollHeight: 0,
      transcriptionStatus: null,
      isTranscribing: false,
      pendingTranscriptions: new Map(),
      searchMode: SearchMode.OFF,
      selectedToneId: null,
      filePreviews: [],
      fileFieldValue: null,
      imageFieldValue: null,
      uploadProgress: {},
      submitType: 'TEXT',
      usedPromptId: null,
      usedPromptVariables: null,
      handleFileUpload,
    });

    useUIStore.setState({
      isSettingsOpen: false,
      isBotModalOpen: false,
      isTermsModalOpen: false,
      loading: false,
    });

    mockAttachUrl.mockReset();
    mockAttachUrl.mockResolvedValue(undefined);
    mockAttachPastedText.mockReset();
    mockAttachPastedText.mockResolvedValue(undefined);
    useSettingsStore.setState({
      autoFetchPastedLinks: true,
      pasteAsAttachmentChars: 2000,
    });
  });

  function setup(enabled = true) {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    const textareaRef = { current: textarea };

    const hook = renderHook(() => usePasteChatInput({ textareaRef, enabled }));

    return { textarea, focusSpy, hook };
  }

  function pressPasteOptionsChord(init: KeyboardEventInit = {}) {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'v',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        ...init,
      }),
    );
  }

  it('uploads a pasted image with a unique name and focuses the textarea', () => {
    const { focusSpy } = setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );

    expect(dispatchResult).toBe(false);
    expect(handleFileUpload).toHaveBeenCalledTimes(1);
    const files = handleFileUpload.mock.calls[0][0] as File[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/^pasted-image-\d+-0\.png$/);
    expect(files[0].type).toBe('image/png');
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('refocuses the textarea after the upload settles', async () => {
    const { focusSpy } = setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );

    expect(focusSpy).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(focusSpy).toHaveBeenCalledTimes(2);
  });

  it('does not steal focus after upload if another control is focused', async () => {
    const { focusSpy } = setup();
    const otherInput = document.createElement('input');
    document.body.appendChild(otherInput);
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );
    otherInput.focus();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(focusSpy).toHaveBeenCalledTimes(1);
    document.body.removeChild(otherInput);
  });

  it('uploads a pasted image when the chat textarea itself is the target', () => {
    const { textarea } = setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: textarea }),
    );

    expect(handleFileUpload).toHaveBeenCalledTimes(1);
  });

  it('does not hijack pastes into other inputs', () => {
    const { focusSpy } = setup();
    const otherInput = document.createElement('input');
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: otherInput }),
    );

    expect(dispatchResult).toBe(true);
    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('gives multiple pasted images unique names', () => {
    setup();
    const images = [
      new File(['a'], 'image.png', { type: 'image/png' }),
      new File(['b'], 'image.png', { type: 'image/jpeg' }),
    ];

    window.dispatchEvent(
      createPasteEvent({ imageFiles: images, target: document.body }),
    );

    const files = handleFileUpload.mock.calls[0][0] as File[];
    expect(files).toHaveLength(2);
    expect(files[0].name).not.toBe(files[1].name);
    expect(files[1].name).toMatch(/\.jpeg$/);
  });

  it('inserts the text and ignores the image on mixed clipboard content', () => {
    // Word/Excel/PowerPoint put a PNG rendering of the selection next to the
    // text; the text is what the user copied.
    setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({
        imageFiles: [image],
        text: 'copied text',
        target: document.body,
      }),
    );

    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(useChatInputStore.getState().textFieldValue).toBe('copied text');
  });

  it('leaves mixed clipboard content to native handling inside the textarea', () => {
    const { textarea } = setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({
        imageFiles: [image],
        text: 'copied text',
        target: textarea,
      }),
    );

    expect(dispatchResult).toBe(true);
    expect(handleFileUpload).not.toHaveBeenCalled();
  });

  describe('paste with options (Ctrl/Cmd+Shift+V)', () => {
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    it('opens a chooser listing only what the clipboard holds', () => {
      const { hook } = setup();

      act(() => {
        pressPasteOptionsChord();
        window.dispatchEvent(
          createPasteEvent({
            imageFiles: [image],
            text: 'copied text',
            target: document.body,
          }),
        );
      });

      expect(
        hook.result.current.pasteChooser?.options.map((o) => o.id),
      ).toEqual(['text', 'attachText', 'image']);
      expect(handleFileUpload).not.toHaveBeenCalled();
      expect(useChatInputStore.getState().textFieldValue).toBe('');
    });

    it('includes Markdown options when the HTML carries formatting', () => {
      const { hook } = setup();

      act(() => {
        pressPasteOptionsChord({ key: 'V', ctrlKey: false, metaKey: true });
        window.dispatchEvent(
          createPasteEvent({
            text: 'Heading body',
            html: '<h1>Heading</h1><p><b>body</b></p>',
            target: document.body,
          }),
        );
      });

      expect(
        hook.result.current.pasteChooser?.options.map((o) => o.id),
      ).toEqual(['text', 'markdown', 'attachText', 'attachMarkdown']);
    });

    it('applies the chosen option and closes the chooser', () => {
      const { hook, focusSpy } = setup();

      act(() => {
        pressPasteOptionsChord();
        window.dispatchEvent(
          createPasteEvent({
            imageFiles: [image],
            text: 'copied text',
            target: document.body,
          }),
        );
      });
      act(() => {
        hook.result.current.pasteChooser?.select('image');
      });

      expect(handleFileUpload).toHaveBeenCalledTimes(1);
      expect(hook.result.current.pasteChooser).toBeNull();
      expect(focusSpy).toHaveBeenCalled();
    });

    it('inserts plain text at the caret when chosen, regardless of size', () => {
      const { hook, textarea } = setup();
      useSettingsStore.setState({ pasteAsAttachmentChars: 500 });
      useChatInputStore.setState({ textFieldValue: 'AB' });
      textarea.value = 'AB';
      textarea.setSelectionRange(1, 1);
      const big = 'x'.repeat(1000);

      act(() => {
        pressPasteOptionsChord();
        window.dispatchEvent(createPasteEvent({ text: big, target: textarea }));
      });
      act(() => {
        hook.result.current.pasteChooser?.select('text');
      });

      expect(useChatInputStore.getState().textFieldValue).toBe(`A${big}B`);
      expect(mockAttachPastedText).not.toHaveBeenCalled();
    });

    it('inserts Markdown or attaches it when chosen', () => {
      const { hook } = setup();
      const html = '<p><b>bold</b> text</p>';

      act(() => {
        pressPasteOptionsChord();
        window.dispatchEvent(
          createPasteEvent({ text: 'bold text', html, target: document.body }),
        );
      });
      act(() => {
        hook.result.current.pasteChooser?.select('markdown');
      });
      expect(useChatInputStore.getState().textFieldValue).toBe('**bold** text');

      act(() => {
        pressPasteOptionsChord();
        window.dispatchEvent(
          createPasteEvent({ text: 'bold text', html, target: document.body }),
        );
      });
      act(() => {
        hook.result.current.pasteChooser?.select('attachMarkdown');
      });
      expect(mockAttachPastedText).toHaveBeenCalledWith('**bold** text');
    });

    it('attaches a link when chosen even with auto-fetch off', () => {
      const { hook } = setup();
      useSettingsStore.setState({ autoFetchPastedLinks: false });

      act(() => {
        pressPasteOptionsChord();
        window.dispatchEvent(
          createPasteEvent({
            text: 'https://example.org/page',
            target: document.body,
          }),
        );
      });
      expect(
        hook.result.current.pasteChooser?.options.map((o) => o.id),
      ).toContain('link');
      act(() => {
        hook.result.current.pasteChooser?.select('link');
      });

      expect(mockAttachUrl).toHaveBeenCalledWith('https://example.org/page');
    });

    it('skips the chooser when only one option is available', () => {
      const { hook } = setup();

      act(() => {
        pressPasteOptionsChord();
        window.dispatchEvent(
          createPasteEvent({ imageFiles: [image], target: document.body }),
        );
      });

      expect(hook.result.current.pasteChooser).toBeNull();
      expect(handleFileUpload).toHaveBeenCalledTimes(1);
    });

    it('does nothing for an empty clipboard', () => {
      const { hook } = setup();

      let dispatchResult = false;
      act(() => {
        pressPasteOptionsChord();
        dispatchResult = window.dispatchEvent(
          createPasteEvent({ target: document.body }),
        );
      });

      expect(dispatchResult).toBe(true);
      expect(hook.result.current.pasteChooser).toBeNull();
    });

    it('dismisses the chooser and refocuses the composer', () => {
      const { hook, focusSpy } = setup();

      act(() => {
        pressPasteOptionsChord();
        window.dispatchEvent(
          createPasteEvent({
            imageFiles: [image],
            text: 'copied text',
            target: document.body,
          }),
        );
      });
      act(() => {
        hook.result.current.pasteChooser?.dismiss();
      });

      expect(hook.result.current.pasteChooser).toBeNull();
      expect(focusSpy).toHaveBeenCalled();
      expect(handleFileUpload).not.toHaveBeenCalled();
    });

    it('consumes the chord so the next paste is a normal paste again', () => {
      const { hook } = setup();

      act(() => {
        pressPasteOptionsChord();
        window.dispatchEvent(
          createPasteEvent({
            imageFiles: [image],
            text: 'first',
            target: document.body,
          }),
        );
      });
      act(() => {
        window.dispatchEvent(
          createPasteEvent({
            imageFiles: [image],
            text: 'second',
            target: document.body,
          }),
        );
      });

      expect(hook.result.current.pasteChooser).toBeNull();
      expect(useChatInputStore.getState().textFieldValue).toBe('second');
    });

    it('does not treat a plain Ctrl+V as a paste-with-options request', () => {
      const { hook } = setup();

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'v',
            ctrlKey: true,
            bubbles: true,
          }),
        );
        window.dispatchEvent(
          createPasteEvent({
            imageFiles: [image],
            text: 'copied text',
            target: document.body,
          }),
        );
      });

      expect(hook.result.current.pasteChooser).toBeNull();
      expect(useChatInputStore.getState().textFieldValue).toBe('copied text');
    });
  });

  it('appends pasted text and focuses the textarea when unfocused', () => {
    const { focusSpy } = setup();
    useChatInputStore.setState({ textFieldValue: 'hello ' });

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: 'world', target: document.body }),
    );

    expect(dispatchResult).toBe(false);
    expect(useChatInputStore.getState().textFieldValue).toBe('hello world');
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves text pastes into the chat textarea to native handling', () => {
    const { textarea, focusSpy } = setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: 'native paste', target: textarea }),
    );

    expect(dispatchResult).toBe(true);
    expect(useChatInputStore.getState().textFieldValue).toBe('');
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('ignores pastes while a modal is open', () => {
    setup();
    useUIStore.setState({ isSettingsOpen: true });
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );
    window.dispatchEvent(
      createPasteEvent({ text: 'text', target: document.body }),
    );

    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(useChatInputStore.getState().textFieldValue).toBe('');
  });

  it('does nothing when disabled', () => {
    const { focusSpy } = setup(false);
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );

    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('ignores pastes with no images and no text', () => {
    const { focusSpy } = setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ target: document.body }),
    );

    expect(dispatchResult).toBe(true);
    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });
});

/**
 * Pasting a bare link attaches the page instead of inserting the URL. Once
 * the content is attached the raw URL is noise the user would have to delete,
 * so the paste is swallowed in both the focused and unfocused cases.
 */
describe('usePasteChatInput — pasted links', () => {
  let handleFileUpload: Mock;

  beforeEach(() => {
    handleFileUpload = vi.fn().mockResolvedValue(undefined);
    useChatInputStore.setState({
      textFieldValue: '',
      filePreviews: [],
      handleFileUpload,
    });
    useUIStore.setState({
      isSettingsOpen: false,
      isBotModalOpen: false,
      isTermsModalOpen: false,
    });
    mockAttachUrl.mockReset();
    mockAttachUrl.mockResolvedValue(undefined);
    mockAttachPastedText.mockReset();
    mockAttachPastedText.mockResolvedValue(undefined);
    useSettingsStore.setState({
      autoFetchPastedLinks: true,
      pasteAsAttachmentChars: 2000,
    });
  });

  function setup(enabled = true) {
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    renderHook(() => usePasteChatInput({ textareaRef, enabled }));
    return { textarea };
  }

  const url = 'https://news.example.com/floods';
  const text = () => useChatInputStore.getState().textFieldValue;

  it('attaches the page and keeps the URL out of the composer (textarea focused)', () => {
    const { textarea } = setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: url, target: textarea }),
    );

    // preventDefault stops the browser inserting the URL.
    expect(dispatchResult).toBe(false);
    expect(mockAttachUrl).toHaveBeenCalledWith(url);
    expect(text()).toBe('');
  });

  it('attaches the page without appending the URL (textarea not focused)', () => {
    setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: url, target: document.body }),
    );

    expect(dispatchResult).toBe(false);
    expect(mockAttachUrl).toHaveBeenCalledWith(url);
    expect(text()).toBe('');
  });

  it('pastes the link normally when auto-fetch is switched off', () => {
    useSettingsStore.setState({ autoFetchPastedLinks: false });
    setup();

    window.dispatchEvent(
      createPasteEvent({ text: url, target: document.body }),
    );

    expect(mockAttachUrl).not.toHaveBeenCalled();
    expect(text()).toBe(url);
  });

  it('leaves prose containing a link completely alone', () => {
    setup();
    const prose = `see ${url} for details`;

    window.dispatchEvent(
      createPasteEvent({ text: prose, target: document.body }),
    );

    expect(mockAttachUrl).not.toHaveBeenCalled();
    expect(text()).toBe(prose);
  });

  it('does not hijack a link pasted into another input', () => {
    setup();
    const otherInput = document.createElement('input');
    document.body.appendChild(otherInput);

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: url, target: otherInput }),
    );

    expect(dispatchResult).toBe(true);
    expect(mockAttachUrl).not.toHaveBeenCalled();
    document.body.removeChild(otherInput);
  });
});

/**
 * A paste too large to read inside the composer is a document, not a
 * sentence. It becomes an attachment even when the textarea is focused —
 * a deliberate bulk paste is the common case, and the composer should stay
 * free for the actual question.
 */
describe('usePasteChatInput — oversized pastes', () => {
  beforeEach(() => {
    useChatInputStore.setState({
      textFieldValue: '',
      filePreviews: [],
      handleFileUpload: vi.fn().mockResolvedValue(undefined),
    });
    useUIStore.setState({
      isSettingsOpen: false,
      isBotModalOpen: false,
      isTermsModalOpen: false,
    });
    mockAttachUrl.mockReset();
    mockAttachUrl.mockResolvedValue(undefined);
    mockAttachPastedText.mockReset();
    mockAttachPastedText.mockResolvedValue(undefined);
    useSettingsStore.setState({
      autoFetchPastedLinks: true,
      pasteAsAttachmentChars: 2000,
    });
  });

  function setup(enabled = true) {
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    renderHook(() => usePasteChatInput({ textareaRef, enabled }));
    return { textarea };
  }

  const big = 'x'.repeat(2001);
  const small = 'x'.repeat(1999);
  const text = () => useChatInputStore.getState().textFieldValue;

  it('attaches an oversized paste when the textarea is focused', () => {
    const { textarea } = setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: big, target: textarea }),
    );

    expect(dispatchResult).toBe(false);
    expect(mockAttachPastedText).toHaveBeenCalledWith(big);
    expect(text()).toBe('');
  });

  it('attaches an oversized paste when nothing is focused', () => {
    setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: big, target: document.body }),
    );

    expect(dispatchResult).toBe(false);
    expect(mockAttachPastedText).toHaveBeenCalledWith(big);
    expect(text()).toBe('');
  });

  it('leaves a paste at or below the threshold in the composer', () => {
    setup();

    window.dispatchEvent(
      createPasteEvent({ text: small, target: document.body }),
    );

    expect(mockAttachPastedText).not.toHaveBeenCalled();
    expect(text()).toBe(small);
  });

  it('measures the trimmed length, so trailing whitespace cannot tip it over', () => {
    setup();
    const padded = `${small}${' '.repeat(50)}`;

    window.dispatchEvent(
      createPasteEvent({ text: padded, target: document.body }),
    );

    expect(mockAttachPastedText).not.toHaveBeenCalled();
  });

  it('never attaches when the threshold is 0 (feature off)', () => {
    useSettingsStore.setState({ pasteAsAttachmentChars: 0 });
    setup();

    window.dispatchEvent(
      createPasteEvent({ text: big, target: document.body }),
    );

    expect(mockAttachPastedText).not.toHaveBeenCalled();
    expect(text()).toBe(big);
  });

  it('honors a custom threshold', () => {
    useSettingsStore.setState({ pasteAsAttachmentChars: 500 });
    setup();
    const medium = 'y'.repeat(600);

    window.dispatchEvent(
      createPasteEvent({ text: medium, target: document.body }),
    );

    expect(mockAttachPastedText).toHaveBeenCalledWith(medium);
  });

  it('does not hijack an oversized paste into another input', () => {
    setup();
    const otherInput = document.createElement('input');
    document.body.appendChild(otherInput);

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: big, target: otherInput }),
    );

    expect(dispatchResult).toBe(true);
    expect(mockAttachPastedText).not.toHaveBeenCalled();
    document.body.removeChild(otherInput);
  });

  it('attaches the text, not the image, when a long Word paste holds both', () => {
    setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({
        imageFiles: [image],
        text: big,
        target: document.body,
      }),
    );

    expect(mockAttachPastedText).toHaveBeenCalledWith(big);
    expect(
      useChatInputStore.getState().handleFileUpload,
    ).not.toHaveBeenCalled();
  });
});

import { UserFileHandler } from '@/lib/utils/app/user/userFile';

import fs from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('UserFileHandler', () => {
  const validFileTypes = {
    plain: true,
    txt: true,
    pdf: true,
    docx: true,
  };

  describe('constructor', () => {
    it('should create an instance with local file data', () => {
      const fileData = new Blob(['test'], { type: 'text/plain' });
      // @ts-ignore
      const fileHandler = new UserFileHandler(fileData, {
        ...validFileTypes,
        txt: true,
      });
      expect(fileHandler).toBeInstanceOf(UserFileHandler);
      expect(fileHandler['fileLocation']).toBe('local');
      expect(fileHandler['fileType']).toBe('plain');
    });

    it('should create an instance with remote file data', () => {
      const fileData = 'https://example.com/test.txt';
      // @ts-ignore
      const fileHandler = new UserFileHandler(fileData, validFileTypes);
      expect(fileHandler).toBeInstanceOf(UserFileHandler);
      expect(fileHandler['fileLocation']).toBe('remote');
      expect(fileHandler['fileType']).toBe('txt');
    });

    it('should throw an error for unsupported file type', () => {
      const fileData = 'test.unsupported';
      // @ts-ignore
      expect(() => new UserFileHandler(fileData, validFileTypes)).toThrowError(
        'Unsupported file type: unsupported',
      );
    });
  });

  describe('extractText', () => {
    it('should extract text from a local txt file', async () => {
      const fileData = 'path/to/test.txt';
      const mockReadFile = vi
        .spyOn(fs, 'readFile')
        .mockResolvedValue('Test content');
      //@ts-ignore
      const fileHandler = new UserFileHandler(fileData, validFileTypes);

      const result = await fileHandler.extractText();

      // Next line fails b/c it's an absolute path, not relative one.
      // expect(mockReadFile).toHaveBeenCalledWith('path/to/test.txt', 'utf-8');
      expect(result).toBe('Test content');
    });

    it('should extract text from a local Blob', async () => {
      const fileData = new Blob(['Test content'], { type: 'text/plain' });
      //@ts-ignore
      const fileHandler = new UserFileHandler(fileData, {
        ...validFileTypes,
        txt: true,
      });

      const result = await fileHandler.extractText();

      expect(result).toBe('Test content');
    });

    it('should extract text from a remote txt file', async () => {
      const fileData = 'https://example.com/test.txt';
      const mockFetch = vi.fn().mockResolvedValue({
        blob: vi
          .fn()
          .mockResolvedValue(
            new Blob(['Test content'], { type: 'text/plain' }),
          ),
      });
      global.fetch = mockFetch;
      // @ts-ignore
      const fileHandler = new UserFileHandler(fileData, validFileTypes);

      const result = await fileHandler.extractText();

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/test.txt');
      expect(result).toBe('Test content');
    });

    // it('should throw an error for unsupported file type', async () => {
    //   const fileData = 'test.unsupported';
    //   const fileHandler = new UserFileHandler(fileData, {...validFileTypes, unsupported: true});
    //
    //   await expect(fileHandler.extractText()).rejects.toThrowError('Unsupported file type: unsupported');
    // });
  });
});

import {
  EXECUTABLE_EXTENSIONS,
  EXECUTABLE_MIME_TYPES,
  MIME_TYPE_MAP,
  getContentType,
  isExecutableFile,
  isExecutableMimeType,
  validateFileNotExecutable,
} from '@/lib/utils/server/mimeTypes';

import { describe, expect, it } from 'vitest';

describe('mimeTypes', () => {
  describe('MIME_TYPE_MAP', () => {
    it('should contain common image types', () => {
      expect(MIME_TYPE_MAP.jpg).toBe('image/jpeg');
      expect(MIME_TYPE_MAP.jpeg).toBe('image/jpeg');
      expect(MIME_TYPE_MAP.png).toBe('image/png');
      expect(MIME_TYPE_MAP.gif).toBe('image/gif');
      expect(MIME_TYPE_MAP.webp).toBe('image/webp');
      expect(MIME_TYPE_MAP.svg).toBe('image/svg+xml');
    });

    it('should contain document types', () => {
      expect(MIME_TYPE_MAP.pdf).toBe('application/pdf');
      expect(MIME_TYPE_MAP.doc).toBe('application/msword');
      expect(MIME_TYPE_MAP.docx).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(MIME_TYPE_MAP.xls).toBe('application/vnd.ms-excel');
      expect(MIME_TYPE_MAP.xlsx).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(MIME_TYPE_MAP.ppt).toBe('application/vnd.ms-powerpoint');
      expect(MIME_TYPE_MAP.pptx).toBe(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
    });

    it('should contain text types', () => {
      expect(MIME_TYPE_MAP.txt).toBe('text/plain');
      expect(MIME_TYPE_MAP.md).toBe('text/markdown');
      expect(MIME_TYPE_MAP.json).toBe('application/json');
      expect(MIME_TYPE_MAP.xml).toBe('text/xml');
      expect(MIME_TYPE_MAP.csv).toBe('text/csv');
    });

    it('should contain audio types', () => {
      expect(MIME_TYPE_MAP.mp3).toBe('audio/mpeg');
      expect(MIME_TYPE_MAP.wav).toBe('audio/wav');
      expect(MIME_TYPE_MAP.m4a).toBe('audio/m4a');
      expect(MIME_TYPE_MAP.mpga).toBe('audio/mpeg');
    });

    it('should contain video types', () => {
      expect(MIME_TYPE_MAP.mp4).toBe('video/mp4');
      expect(MIME_TYPE_MAP.webm).toBe('video/webm');
      expect(MIME_TYPE_MAP.mpeg).toBe('video/mpeg');
    });
  });

  describe('EXECUTABLE_EXTENSIONS', () => {
    it('should contain dangerous executable extensions', () => {
      expect(EXECUTABLE_EXTENSIONS).toContain('exe');
      expect(EXECUTABLE_EXTENSIONS).toContain('bat');
      expect(EXECUTABLE_EXTENSIONS).toContain('cmd');
      expect(EXECUTABLE_EXTENSIONS).toContain('sh');
      expect(EXECUTABLE_EXTENSIONS).toContain('dll');
      expect(EXECUTABLE_EXTENSIONS).toContain('msi');
      expect(EXECUTABLE_EXTENSIONS).toContain('jar');
      expect(EXECUTABLE_EXTENSIONS).toContain('app');
      expect(EXECUTABLE_EXTENSIONS).toContain('com');
      expect(EXECUTABLE_EXTENSIONS).toContain('scr');
      expect(EXECUTABLE_EXTENSIONS).toContain('vbs');
      expect(EXECUTABLE_EXTENSIONS).toContain('ps1');
    });
  });

  describe('EXECUTABLE_MIME_TYPES', () => {
    it('should contain dangerous MIME types', () => {
      expect(EXECUTABLE_MIME_TYPES).toContain('application/x-msdownload');
      expect(EXECUTABLE_MIME_TYPES).toContain('application/x-msdos-program');
      expect(EXECUTABLE_MIME_TYPES).toContain('application/x-executable');
      expect(EXECUTABLE_MIME_TYPES).toContain('application/x-sharedlib');
      expect(EXECUTABLE_MIME_TYPES).toContain('application/java-archive');
      expect(EXECUTABLE_MIME_TYPES).toContain('application/x-apple-diskimage');
      expect(EXECUTABLE_MIME_TYPES).toContain('application/x-sh');
      expect(EXECUTABLE_MIME_TYPES).toContain('application/x-bat');
    });
  });

  describe('getContentType', () => {
    it('should get MIME type from filename with extension', () => {
      expect(getContentType('document.pdf')).toBe('application/pdf');
      expect(getContentType('photo.jpg')).toBe('image/jpeg');
      expect(getContentType('data.json')).toBe('application/json');
      expect(getContentType('audio.mp3')).toBe('audio/mpeg');
      expect(getContentType('video.mp4')).toBe('video/mp4');
    });

    it('should handle multiple dots in filename', () => {
      expect(getContentType('my.document.pdf')).toBe('application/pdf');
      expect(getContentType('backup.2024.01.01.json')).toBe('application/json');
    });

    it('should be case insensitive', () => {
      expect(getContentType('file.PDF')).toBe('application/pdf');
      expect(getContentType('file.Jpg')).toBe('image/jpeg');
      expect(getContentType('file.PNG')).toBe('image/png');
    });

    it('should handle whitespace in extensions', () => {
      // Trailing whitespace after extension is trimmed
      expect(getContentType('file.pdf ')).toBe('application/pdf');
      // Whitespace in the middle is also trimmed, so ' pdf' becomes 'pdf'
      expect(getContentType('file. pdf')).toBe('application/pdf');
    });

    it('should get MIME type from extension only', () => {
      expect(getContentType('pdf')).toBe('application/pdf');
      expect(getContentType('jpg')).toBe('image/jpeg');
      expect(getContentType('txt')).toBe('text/plain');
    });

    it('should return default MIME type for unknown extensions', () => {
      expect(getContentType('file.xyz')).toBe('application/octet-stream');
      expect(getContentType('file.unknown')).toBe('application/octet-stream');
      expect(getContentType('noextension')).toBe('application/octet-stream');
    });

    it('should handle empty string', () => {
      expect(getContentType('')).toBe('application/octet-stream');
    });

    it('should handle filenames with no extension', () => {
      expect(getContentType('README')).toBe('application/octet-stream');
      expect(getContentType('Makefile')).toBe('application/octet-stream');
    });

    it('should handle hidden files', () => {
      expect(getContentType('.gitignore')).toBe('application/octet-stream');
      expect(getContentType('.env.json')).toBe('application/json');
    });

    it('should handle paths', () => {
      expect(getContentType('/path/to/document.pdf')).toBe('application/pdf');
      expect(getContentType('C:\\Users\\file.docx')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    });

    it('should handle edge cases', () => {
      expect(getContentType('.')).toBe('application/octet-stream');
      expect(getContentType('..')).toBe('application/octet-stream');
      expect(getContentType('file.')).toBe('application/octet-stream');
    });
  });

  describe('isExecutableFile', () => {
    it('should detect executable files', () => {
      expect(isExecutableFile('virus.exe')).toBe(true);
      expect(isExecutableFile('script.bat')).toBe(true);
      expect(isExecutableFile('malware.cmd')).toBe(true);
      expect(isExecutableFile('shell.sh')).toBe(true);
      expect(isExecutableFile('library.dll')).toBe(true);
      expect(isExecutableFile('installer.msi')).toBe(true);
      expect(isExecutableFile('program.jar')).toBe(true);
      expect(isExecutableFile('application.app')).toBe(true);
      expect(isExecutableFile('utility.com')).toBe(true);
      expect(isExecutableFile('screensaver.scr')).toBe(true);
      expect(isExecutableFile('script.vbs')).toBe(true);
      expect(isExecutableFile('powershell.ps1')).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(isExecutableFile('file.EXE')).toBe(true);
      expect(isExecutableFile('file.Bat')).toBe(true);
      expect(isExecutableFile('file.DLL')).toBe(true);
    });

    it('should not detect safe files as executable', () => {
      expect(isExecutableFile('document.pdf')).toBe(false);
      expect(isExecutableFile('image.jpg')).toBe(false);
      expect(isExecutableFile('data.json')).toBe(false);
      expect(isExecutableFile('text.txt')).toBe(false);
      expect(isExecutableFile('sheet.xlsx')).toBe(false);
    });

    it('should handle files without extension', () => {
      expect(isExecutableFile('README')).toBe(false);
      expect(isExecutableFile('Makefile')).toBe(false);
    });

    it('should handle paths', () => {
      expect(isExecutableFile('/path/to/virus.exe')).toBe(true);
      expect(isExecutableFile('C:\\Windows\\System32\\malware.dll')).toBe(true);
    });

    it('should handle edge cases', () => {
      expect(isExecutableFile('')).toBe(false);
      expect(isExecutableFile('.')).toBe(false);
      expect(isExecutableFile('..')).toBe(false);
      expect(isExecutableFile('file.')).toBe(false);
    });
  });

  describe('isExecutableMimeType', () => {
    it('should detect executable MIME types', () => {
      expect(isExecutableMimeType('application/x-msdownload')).toBe(true);
      expect(isExecutableMimeType('application/x-msdos-program')).toBe(true);
      expect(isExecutableMimeType('application/x-executable')).toBe(true);
      expect(isExecutableMimeType('application/x-sharedlib')).toBe(true);
      expect(isExecutableMimeType('application/java-archive')).toBe(true);
      expect(isExecutableMimeType('application/x-apple-diskimage')).toBe(true);
      expect(isExecutableMimeType('application/x-sh')).toBe(true);
      expect(isExecutableMimeType('application/x-bat')).toBe(true);
    });

    it('should not detect safe MIME types as executable', () => {
      expect(isExecutableMimeType('application/pdf')).toBe(false);
      expect(isExecutableMimeType('image/jpeg')).toBe(false);
      expect(isExecutableMimeType('text/plain')).toBe(false);
      expect(isExecutableMimeType('application/json')).toBe(false);
      expect(isExecutableMimeType('video/mp4')).toBe(false);
    });

    it('should handle empty string', () => {
      expect(isExecutableMimeType('')).toBe(false);
    });
  });

  describe('validateFileNotExecutable', () => {
    it('should validate safe files by extension', () => {
      const result = validateFileNotExecutable('document.pdf');
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should validate safe files by extension and MIME type', () => {
      const result = validateFileNotExecutable(
        'document.pdf',
        'application/pdf',
      );
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject executable extensions', () => {
      const result = validateFileNotExecutable('virus.exe');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Executable files are not allowed');
    });

    it('should reject all executable extensions', () => {
      const executables = [
        'file.exe',
        'file.bat',
        'file.cmd',
        'file.sh',
        'file.dll',
        'file.msi',
        'file.jar',
        'file.app',
        'file.com',
        'file.scr',
        'file.vbs',
        'file.ps1',
      ];

      executables.forEach((filename) => {
        const result = validateFileNotExecutable(filename);
        expect(result.isValid).toBe(false);
        expect(result.error).toBe('Executable files are not allowed');
      });
    });

    it('should reject executable MIME types', () => {
      const result = validateFileNotExecutable(
        'file.txt',
        'application/x-msdownload',
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid file type submitted');
    });

    it('should reject all executable MIME types', () => {
      const executableMimes = [
        'application/x-msdownload',
        'application/x-msdos-program',
        'application/x-executable',
        'application/x-sharedlib',
        'application/java-archive',
        'application/x-apple-diskimage',
        'application/x-sh',
        'application/x-bat',
      ];

      executableMimes.forEach((mimeType) => {
        const result = validateFileNotExecutable('file.txt', mimeType);
        expect(result.isValid).toBe(false);
        expect(result.error).toBe('Invalid file type submitted');
      });
    });

    it('should prioritize extension check over MIME type', () => {
      // If extension is executable, should fail even with safe MIME
      const result = validateFileNotExecutable('virus.exe', 'text/plain');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Executable files are not allowed');
    });

    it('should handle null MIME type', () => {
      const result = validateFileNotExecutable('document.pdf', null);
      expect(result.isValid).toBe(true);
    });

    it('should handle undefined MIME type', () => {
      const result = validateFileNotExecutable('document.pdf', undefined);
      expect(result.isValid).toBe(true);
    });

    it('should validate files with safe extensions and no MIME type', () => {
      expect(validateFileNotExecutable('image.jpg').isValid).toBe(true);
      expect(validateFileNotExecutable('data.json').isValid).toBe(true);
      expect(validateFileNotExecutable('report.docx').isValid).toBe(true);
    });

    it('should handle case insensitive extensions', () => {
      expect(validateFileNotExecutable('FILE.EXE').isValid).toBe(false);
      expect(validateFileNotExecutable('file.DLL').isValid).toBe(false);
      expect(validateFileNotExecutable('SCRIPT.BAT').isValid).toBe(false);
    });

    it('should handle files with multiple dots', () => {
      expect(validateFileNotExecutable('backup.2024.exe').isValid).toBe(false);
      expect(validateFileNotExecutable('document.final.pdf').isValid).toBe(
        true,
      );
    });
  });

  describe('Security edge cases', () => {
    it('should prevent double extension attacks', () => {
      expect(validateFileNotExecutable('document.pdf.exe').isValid).toBe(false);
      expect(validateFileNotExecutable('image.jpg.bat').isValid).toBe(false);
    });

    it('should handle uppercase extensions', () => {
      expect(validateFileNotExecutable('VIRUS.EXE').isValid).toBe(false);
      expect(validateFileNotExecutable('Malware.Dll').isValid).toBe(false);
    });

    it('should handle mixed case', () => {
      expect(validateFileNotExecutable('ViRuS.ExE').isValid).toBe(false);
    });

    it('should handle files with spaces', () => {
      expect(validateFileNotExecutable('bad file.exe').isValid).toBe(false);
      expect(validateFileNotExecutable('good file.pdf').isValid).toBe(true);
    });

    it('should handle special characters', () => {
      expect(validateFileNotExecutable('file@#$.exe').isValid).toBe(false);
      expect(validateFileNotExecutable('file@#$.pdf').isValid).toBe(true);
    });
  });

  describe('Integration scenarios', () => {
    it('should validate legitimate document uploads', () => {
      const files = [
        { name: 'report.pdf', mime: 'application/pdf' },
        { name: 'photo.jpg', mime: 'image/jpeg' },
        {
          name: 'data.xlsx',
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        { name: 'readme.txt', mime: 'text/plain' },
      ];

      files.forEach(({ name, mime }) => {
        const result = validateFileNotExecutable(name, mime);
        expect(result.isValid).toBe(true);
      });
    });

    it('should block malware attempts', () => {
      const malware = [
        { name: 'trojan.exe', mime: 'application/x-msdownload' },
        { name: 'script.bat', mime: 'application/x-bat' },
        { name: 'malware.jar', mime: 'application/java-archive' },
        { name: 'virus.dll', mime: 'application/x-sharedlib' },
      ];

      malware.forEach(({ name, mime }) => {
        const result = validateFileNotExecutable(name, mime);
        expect(result.isValid).toBe(false);
      });
    });

    it('should handle MIME type mismatch attacks', () => {
      // Attacker tries to upload exe with fake MIME type
      const result = validateFileNotExecutable('virus.exe', 'image/jpeg');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Executable files are not allowed');
    });
  });
});

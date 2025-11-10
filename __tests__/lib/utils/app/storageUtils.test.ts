import { formatBytes } from '@/lib/utils/app/storage/storageUtils';

import { describe, expect, it } from 'vitest';

describe('storageUtils', () => {
  describe('formatBytes', () => {
    describe('Bytes', () => {
      it('formats 0 bytes', () => {
        expect(formatBytes(0)).toBe('0 B');
      });

      it('formats single byte', () => {
        expect(formatBytes(1)).toBe('1 B');
      });

      it('formats small bytes', () => {
        expect(formatBytes(100)).toBe('100 B');
        expect(formatBytes(500)).toBe('500 B');
        expect(formatBytes(999)).toBe('999 B');
      });

      it('formats exactly 1023 bytes', () => {
        expect(formatBytes(1023)).toBe('1023 B');
      });
    });

    describe('Kilobytes', () => {
      it('formats exactly 1 KB', () => {
        expect(formatBytes(1024)).toBe('1.00 KB');
      });

      it('formats small kilobytes', () => {
        expect(formatBytes(2048)).toBe('2.00 KB');
        expect(formatBytes(5120)).toBe('5.00 KB');
      });

      it('formats kilobytes with decimals', () => {
        expect(formatBytes(1536)).toBe('1.50 KB'); // 1.5 KB
        expect(formatBytes(2560)).toBe('2.50 KB'); // 2.5 KB
      });

      it('formats fractional kilobytes', () => {
        expect(formatBytes(1100)).toBe('1.07 KB');
        expect(formatBytes(1234)).toBe('1.21 KB');
      });

      it('formats large kilobytes', () => {
        expect(formatBytes(102400)).toBe('100.00 KB');
        expect(formatBytes(512000)).toBe('500.00 KB');
      });

      it('formats exactly 1023 KB (1047552 bytes)', () => {
        expect(formatBytes(1047552)).toBe('1023.00 KB');
      });
    });

    describe('Megabytes', () => {
      it('formats exactly 1 MB', () => {
        expect(formatBytes(1048576)).toBe('1.00 MB'); // 1024 * 1024
      });

      it('formats small megabytes', () => {
        expect(formatBytes(2097152)).toBe('2.00 MB'); // 2 MB
        expect(formatBytes(5242880)).toBe('5.00 MB'); // 5 MB
      });

      it('formats megabytes with decimals', () => {
        expect(formatBytes(1572864)).toBe('1.50 MB'); // 1.5 MB
        expect(formatBytes(2621440)).toBe('2.50 MB'); // 2.5 MB
      });

      it('formats fractional megabytes', () => {
        expect(formatBytes(1153434)).toBe('1.10 MB'); // ~1.1 MB
        expect(formatBytes(12345678)).toBe('11.77 MB');
      });

      it('formats large megabytes', () => {
        expect(formatBytes(104857600)).toBe('100.00 MB'); // 100 MB
        expect(formatBytes(524288000)).toBe('500.00 MB'); // 500 MB
        expect(formatBytes(1073741824)).toBe('1024.00 MB'); // 1 GB (1024 MB)
      });
    });

    describe('Edge Cases', () => {
      it('handles very small fractional KB', () => {
        expect(formatBytes(1025)).toBe('1.00 KB');
        expect(formatBytes(1050)).toBe('1.03 KB');
      });

      it('handles boundary between KB and MB', () => {
        expect(formatBytes(1048575)).toBe('1024.00 KB'); // Just under 1 MB
        expect(formatBytes(1048576)).toBe('1.00 MB'); // Exactly 1 MB
        expect(formatBytes(1048577)).toBe('1.00 MB'); // Just over 1 MB
      });

      it('handles very large files', () => {
        expect(formatBytes(10737418240)).toBe('10240.00 MB'); // 10 GB
        expect(formatBytes(107374182400)).toBe('102400.00 MB'); // 100 GB
      });

      it('rounds to 2 decimal places', () => {
        expect(formatBytes(1025.678)).toBe('1.00 KB');
        expect(formatBytes(1234567)).toBe('1.18 MB');
      });

      it('handles negative numbers (edge case)', () => {
        // While negative bytes don't make sense, the function treats them as bytes
        expect(formatBytes(-1024)).toBe('-1024 B');
        expect(formatBytes(-1)).toBe('-1 B');
      });

      it('handles decimal inputs', () => {
        expect(formatBytes(1536.5)).toBe('1.50 KB');
        expect(formatBytes(1048576.5)).toBe('1.00 MB');
      });
    });

    describe('Common File Sizes', () => {
      it('formats typical document sizes', () => {
        expect(formatBytes(51200)).toBe('50.00 KB'); // Small document
        expect(formatBytes(204800)).toBe('200.00 KB'); // Medium document
        expect(formatBytes(1048576)).toBe('1.00 MB'); // Large document
      });

      it('formats typical image sizes', () => {
        expect(formatBytes(102400)).toBe('100.00 KB'); // Thumbnail
        expect(formatBytes(524288)).toBe('512.00 KB'); // Small image
        expect(formatBytes(2097152)).toBe('2.00 MB'); // High-res image
        expect(formatBytes(10485760)).toBe('10.00 MB'); // Very high-res image
      });

      it('formats typical video sizes', () => {
        expect(formatBytes(52428800)).toBe('50.00 MB'); // Short video
        expect(formatBytes(209715200)).toBe('200.00 MB'); // Medium video
        expect(formatBytes(1073741824)).toBe('1024.00 MB'); // HD video
      });
    });

    describe('Precision', () => {
      it('always uses 2 decimal places for KB', () => {
        const result = formatBytes(1536);
        expect(result).toMatch(/^\d+\.\d{2} KB$/);
      });

      it('always uses 2 decimal places for MB', () => {
        const result = formatBytes(1572864);
        expect(result).toMatch(/^\d+\.\d{2} MB$/);
      });

      it('does not use decimal places for bytes', () => {
        const result = formatBytes(100);
        expect(result).toBe('100 B');
        expect(result).not.toContain('.');
      });
    });

    describe('Special Numbers', () => {
      it('handles Number.MAX_SAFE_INTEGER', () => {
        const result = formatBytes(Number.MAX_SAFE_INTEGER);
        expect(result).toContain('MB');
        expect(result).toMatch(/^\d+\.\d{2} MB$/);
      });

      it('handles Infinity', () => {
        const result = formatBytes(Infinity);
        expect(result).toBe('Infinity MB');
      });

      it('handles NaN', () => {
        const result = formatBytes(NaN);
        // NaN < 1024 is false, so it goes to MB path
        expect(result).toBe('NaN MB');
      });
    });

    describe('Consistency', () => {
      it('uses consistent units for similar sizes', () => {
        expect(formatBytes(1023)).toBe('1023 B');
        expect(formatBytes(1024)).toBe('1.00 KB');
        expect(formatBytes(1025)).toBe('1.00 KB');
      });

      it('returns string type', () => {
        expect(typeof formatBytes(0)).toBe('string');
        expect(typeof formatBytes(1024)).toBe('string');
        expect(typeof formatBytes(1048576)).toBe('string');
      });
    });
  });
});

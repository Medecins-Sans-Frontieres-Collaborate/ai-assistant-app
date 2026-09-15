import {
  DEFAULT_MODEL_TIMEOUT_SECONDS,
  MAX_MODEL_TIMEOUT_SECONDS,
  MIN_MODEL_TIMEOUT_SECONDS,
  clampModelTimeoutMs,
  clampModelTimeoutSeconds,
  escalateModelTimeoutSeconds,
  isModelTimeoutErrorCode,
  modelTimeoutPresetFor,
  splitTimeoutDuration,
} from '@/lib/utils/shared/chat/modelTimeout';

import { describe, expect, it } from 'vitest';

describe('modelTimeout (issue #130)', () => {
  describe('clampModelTimeoutSeconds', () => {
    it('keeps in-range values (rounded to whole seconds)', () => {
      expect(clampModelTimeoutSeconds(90)).toBe(90);
      expect(clampModelTimeoutSeconds(120.4)).toBe(120);
      expect(clampModelTimeoutSeconds('150')).toBe(150);
    });

    it('clamps to the bounds', () => {
      expect(clampModelTimeoutSeconds(1)).toBe(MIN_MODEL_TIMEOUT_SECONDS);
      expect(clampModelTimeoutSeconds(99_999)).toBe(MAX_MODEL_TIMEOUT_SECONDS);
    });

    it('resolves garbage to the default rather than disabling the timeout', () => {
      expect(clampModelTimeoutSeconds(undefined)).toBe(
        DEFAULT_MODEL_TIMEOUT_SECONDS,
      );
      expect(clampModelTimeoutSeconds(null)).toBe(
        DEFAULT_MODEL_TIMEOUT_SECONDS,
      );
      expect(clampModelTimeoutSeconds('abc')).toBe(
        DEFAULT_MODEL_TIMEOUT_SECONDS,
      );
      expect(clampModelTimeoutSeconds(NaN)).toBe(DEFAULT_MODEL_TIMEOUT_SECONDS);
      expect(clampModelTimeoutSeconds(Infinity)).toBe(
        DEFAULT_MODEL_TIMEOUT_SECONDS,
      );
      expect(clampModelTimeoutSeconds(0)).toBe(DEFAULT_MODEL_TIMEOUT_SECONDS);
      expect(clampModelTimeoutSeconds(-5)).toBe(DEFAULT_MODEL_TIMEOUT_SECONDS);
    });
  });

  describe('clampModelTimeoutMs', () => {
    it('clamps on the wire unit and returns whole seconds in ms', () => {
      expect(clampModelTimeoutMs(90_000)).toBe(90_000);
      expect(clampModelTimeoutMs(1)).toBe(MIN_MODEL_TIMEOUT_SECONDS * 1000);
      expect(clampModelTimeoutMs(10_000_000)).toBe(
        MAX_MODEL_TIMEOUT_SECONDS * 1000,
      );
      expect(clampModelTimeoutMs(90_400)).toBe(90_000);
      expect(clampModelTimeoutMs('nope')).toBe(
        DEFAULT_MODEL_TIMEOUT_SECONDS * 1000,
      );
    });
  });

  describe('escalateModelTimeoutSeconds', () => {
    it('doubles and caps at the ceiling', () => {
      expect(escalateModelTimeoutSeconds(90)).toBe(180);
      expect(escalateModelTimeoutSeconds(180)).toBe(360);
      expect(escalateModelTimeoutSeconds(360)).toBe(MAX_MODEL_TIMEOUT_SECONDS);
    });

    it('returns null once the ceiling has been used', () => {
      expect(escalateModelTimeoutSeconds(MAX_MODEL_TIMEOUT_SECONDS)).toBeNull();
      expect(escalateModelTimeoutSeconds(99_999)).toBeNull();
    });
  });

  describe('splitTimeoutDuration', () => {
    it('uses minutes only for whole minutes from two minutes up', () => {
      expect(splitTimeoutDuration(90)).toEqual({ unit: 'seconds', count: 90 });
      expect(splitTimeoutDuration(60)).toEqual({ unit: 'seconds', count: 60 });
      expect(splitTimeoutDuration(120)).toEqual({ unit: 'minutes', count: 2 });
      expect(splitTimeoutDuration(180)).toEqual({ unit: 'minutes', count: 3 });
      expect(splitTimeoutDuration(150)).toEqual({
        unit: 'seconds',
        count: 150,
      });
      expect(splitTimeoutDuration(600)).toEqual({ unit: 'minutes', count: 10 });
    });
  });

  describe('modelTimeoutPresetFor', () => {
    it('maps preset values and everything else to custom', () => {
      expect(modelTimeoutPresetFor(90)).toBe('standard');
      expect(modelTimeoutPresetFor(180)).toBe('patient');
      expect(modelTimeoutPresetFor(600)).toBe('maximum');
      expect(modelTimeoutPresetFor(45)).toBe('custom');
    });
  });

  describe('isModelTimeoutErrorCode', () => {
    it('recognises both server timeout codes and nothing else', () => {
      expect(isModelTimeoutErrorCode('PIPELINE_TIMEOUT')).toBe(true);
      expect(isModelTimeoutErrorCode('REQUEST_TIMEOUT')).toBe(true);
      expect(isModelTimeoutErrorCode('INTERNAL_ERROR')).toBe(false);
      expect(isModelTimeoutErrorCode(null)).toBe(false);
      expect(isModelTimeoutErrorCode(undefined)).toBe(false);
    });
  });
});

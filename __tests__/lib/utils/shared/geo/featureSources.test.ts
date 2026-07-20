import {
  buildSourceIndex,
  featureSource,
  sourceHref,
} from '@/lib/utils/shared/geo/featureSources';

import { MapFeature, MapSourceRecord } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const feature = (over: Partial<MapFeature> = {}): MapFeature => ({
  id: 'f1',
  name: 'Goma',
  description: '',
  lat: 1,
  lon: 1,
  confidence: 'high',
  confidenceReason: '',
  category: 'city',
  ...over,
});

const source = (over: Partial<MapSourceRecord> = {}): MapSourceRecord => ({
  id: 's1',
  name: 'Pasted text',
  addedAt: '2026-07-18T00:00:00Z',
  featureCount: 3,
  kind: 'text',
  ...over,
});

describe('featureSource', () => {
  it('resolves a feature to the run that produced it', () => {
    const index = buildSourceIndex([source(), source({ id: 's2' })]);
    expect(featureSource(feature({ sourceId: 's2' }), index)?.id).toBe('s2');
  });

  it('is null for features saved before source stamping', () => {
    const index = buildSourceIndex([source()]);
    expect(featureSource(feature(), index)).toBeNull();
  });

  it('is null when the source record has been removed', () => {
    expect(
      featureSource(feature({ sourceId: 'gone' }), buildSourceIndex([])),
    ).toBeNull();
  });
});

describe('sourceHref', () => {
  it('links fetched pages', () => {
    expect(
      sourceHref(source({ kind: 'url', url: 'https://example.org/report' })),
    ).toBe('https://example.org/report');
  });

  it('has no link for pasted text, files, or searches', () => {
    expect(sourceHref(source())).toBeNull();
    expect(sourceHref(source({ kind: 'file', name: 'report.pdf' }))).toBeNull();
    expect(sourceHref(source({ kind: 'search', query: 'goma' }))).toBeNull();
    expect(sourceHref(null)).toBeNull();
  });

  it('refuses non-http schemes so a stored URL can never become a payload', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(sourceHref(source({ url }))).toBeNull();
    }
  });
});

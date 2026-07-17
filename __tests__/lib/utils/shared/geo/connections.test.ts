import {
  connectionsWithoutFeature,
  resolveConnections,
} from '@/lib/utils/shared/geo/connections';

import { MapFeature } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const feature = (id: string, name: string): MapFeature => ({
  id,
  name,
  description: '',
  lat: 1,
  lon: 1,
  confidence: 'high',
  confidenceReason: '',
  category: 'city',
});

let counter = 0;
const makeId = () => `conn-${++counter}`;

describe('resolveConnections', () => {
  const features = [
    feature('caracas', 'Caracas'),
    feature('laguaira', 'La Guaira'),
    feature('rio', 'Rio de Janeiro'),
  ];

  it('resolves names case-insensitively to feature ids', () => {
    const { connections, unresolved } = resolveConnections(
      [
        {
          fromName: 'caracas',
          toName: 'LA GUAIRA',
          kind: 'movement',
          description: 'MSF teams travelled to the epicenter',
        },
      ],
      features,
      makeId,
      'src-1',
    );
    expect(unresolved).toBe(0);
    expect(connections[0]).toMatchObject({
      fromId: 'caracas',
      toId: 'laguaira',
      kind: 'movement',
      sourceId: 'src-1',
    });
  });

  it('drops unresolved and self-referencing pairs with a count', () => {
    const { connections, unresolved } = resolveConnections(
      [
        { fromName: 'Caracas', toName: 'Atlantis', kind: 'x', description: '' },
        { fromName: 'Caracas', toName: 'caracas', kind: 'x', description: '' },
        {
          fromName: 'Rio de Janeiro',
          toName: 'Caracas',
          kind: 'coordination',
          description: '',
        },
      ],
      features,
      makeId,
    );
    expect(unresolved).toBe(2);
    expect(connections).toHaveLength(1);
  });

  it('dedupes identical pairs within a run', () => {
    const named = {
      fromName: 'Caracas',
      toName: 'La Guaira',
      kind: 'movement',
      description: 'dup',
    };
    const { connections } = resolveConnections(
      [named, { ...named }],
      features,
      makeId,
    );
    expect(connections).toHaveLength(1);
  });

  it('prefers earlier features on name collisions (incoming-run priority)', () => {
    const { connections } = resolveConnections(
      [
        {
          fromName: 'Caracas',
          toName: 'Rio de Janeiro',
          kind: 'x',
          description: '',
        },
      ],
      [feature('new-caracas', 'Caracas'), ...features],
      makeId,
    );
    expect(connections[0].fromId).toBe('new-caracas');
  });
});

describe('connectionsWithoutFeature', () => {
  it('drops connections touching the removed feature', () => {
    const connections = [
      { id: 'a', fromId: 'x', toId: 'y', kind: 'k', description: '' },
      { id: 'b', fromId: 'y', toId: 'z', kind: 'k', description: '' },
      { id: 'c', fromId: 'x', toId: 'z', kind: 'k', description: '' },
    ];
    const remaining = connectionsWithoutFeature(connections, 'y');
    expect(remaining.map((c) => c.id)).toEqual(['c']);
  });
});

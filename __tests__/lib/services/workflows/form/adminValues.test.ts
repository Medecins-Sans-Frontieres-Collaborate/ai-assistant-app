import {
  applyLockedValues,
  resolvePrefill,
} from '@/lib/services/workflows/form/adminValues';
import { attachTemplate } from '@/lib/services/workflows/form/ledger';
import { fieldStatus } from '@/lib/services/workflows/form/status';

import { FormFillWorkflowState, FormTemplate } from '@/types/formFill';

import { describe, expect, it } from 'vitest';

const template: FormTemplate = {
  id: 'formtpl-aaaaaaaaaaaa',
  name: 'T',
  sections: [{ id: 's', heading: 'S' }],
  fields: [
    {
      id: 'free',
      sectionId: 's',
      label: 'Free',
      type: 'text',
      required: false,
    },
    {
      id: 'org',
      sectionId: 's',
      label: 'Org',
      type: 'text',
      required: false,
      admin: { locked: true, prefill: { kind: 'constant', value: 'MSF' } },
    },
    {
      id: 'who',
      sectionId: 's',
      label: 'Who',
      type: 'text',
      required: false,
      admin: { prefill: { kind: 'user', attribute: 'displayName' } },
    },
    {
      id: 'blank',
      sectionId: 's',
      label: 'Blank',
      type: 'text',
      required: false,
      admin: { locked: true },
    },
  ],
  layout: '',
  origin: 'admin',
  createdAt: '',
  updatedAt: '',
};

describe('resolvePrefill', () => {
  it('resolves constants and user attributes, null otherwise', () => {
    const [free, org, who] = template.fields;
    expect(resolvePrefill(free, undefined)).toBeNull();
    expect(resolvePrefill(org, undefined)).toBe('MSF');
    expect(resolvePrefill(who, { displayName: 'Amina' })).toBe('Amina');
    expect(resolvePrefill(who, { displayName: ' ' })).toBeNull();
    expect(resolvePrefill(who, undefined)).toBeNull();
  });
});

describe('applyLockedValues', () => {
  it('overrides locked fields from the admin copy and leaves the rest', () => {
    const out = applyLockedValues(
      template,
      { free: 'mine', org: 'tampered', who: 'mine too', blank: 'sneaky' },
      { displayName: 'Amina' },
    );
    expect(out).toEqual({ free: 'mine', org: 'MSF', who: 'mine too' });
  });
});

describe('attachTemplate prefills', () => {
  it('locks constant prefills, leaves user prefills editable, ignores unresolved', () => {
    let n = 0;
    const state: FormFillWorkflowState = {
      kind: 'form-fill',
      documents: [],
      sources: [],
      notes: [],
      updatedAt: '',
    };
    const next = attachTemplate(state, template, {
      language: 'English',
      clock: { now: () => 'now', mintId: () => `id${++n}` },
      prefillUser: { displayName: 'Amina' },
    });
    const doc = next.documents[0];
    expect(fieldStatus(template.fields[1], doc.fields.org).status).toBe(
      'confirmed',
    );
    expect(fieldStatus(template.fields[2], doc.fields.who).status).toBe(
      'filled',
    );
    expect(doc.fields.who.decision).toBeUndefined();
    expect(doc.fields.blank).toBeUndefined();
    expect(doc.fields.free).toBeUndefined();
  });
});

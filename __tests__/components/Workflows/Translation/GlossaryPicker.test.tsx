import { fireEvent, render, screen } from '@testing-library/react';

import { AvailableGuide } from '@/client/hooks/settings/useAvailableGuides';

import { TranslationGlossary } from '@/types/workflow';

import {
  GlossaryPicker,
  languageFit,
} from '@/components/Workflows/Translation/GlossaryPicker';

import { describe, expect, it, vi } from 'vitest';

function org(id: string, name: string, targetLang?: string): AvailableGuide {
  return {
    id,
    kind: 'terminology',
    name,
    description: '',
    languages: [],
    targetLang,
    entryCount: 3,
    workflows: ['translation'],
    updatedAt: '2026-09-17T00:00:00.000Z',
  };
}

function mine(
  id: string,
  name: string,
  targetLang?: string,
): TranslationGlossary {
  return {
    id,
    name,
    targetLang,
    entries: [{ source: 'a', target: 'b' }],
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
  };
}

const ORG_FR = 'guide-aaaaaaaaaaaa';
const ORG_ANY = 'guide-bbbbbbbbbbbb';
const ORG_ES = 'guide-cccccccccccc';
const ORG_D = 'guide-dddddddddddd';

function renderPicker(
  overrides: Partial<Parameters<typeof GlossaryPicker>[0]> = {},
) {
  const props = {
    orgGlossaries: [
      org(ORG_ES, 'Spanish medical', 'es'),
      org(ORG_ANY, 'General', undefined),
      org(ORG_FR, 'French medical', 'fr'),
    ],
    personalGlossaries: [
      mine('p1', 'My French', 'fr'),
      mine('p2', 'My Arabic', 'ar'),
    ],
    selectedOrgIds: [] as string[],
    selectedPersonalIds: [] as string[],
    staleOrgIds: [] as string[],
    stalePersonalIds: [] as string[],
    targetLangId: 'fr',
    onToggleOrg: vi.fn(),
    onTogglePersonal: vi.fn(),
    onCopyToMine: vi.fn(async () => undefined),
    onManage: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<GlossaryPicker {...props} />);
  return props;
}

describe('languageFit', () => {
  it('ranks matching, untagged, and other-language glossaries', () => {
    expect(languageFit('fr', 'fr')).toBe('match');
    expect(languageFit(undefined, 'fr')).toBe('any');
    expect(languageFit('es', 'fr')).toBe('other');
    // No target chosen yet: nothing is "other".
    expect(languageFit('es', undefined)).toBe('any');
  });
});

describe('GlossaryPicker', () => {
  it('lists matching then untagged glossaries and collapses other languages', () => {
    renderPicker();
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.map((c) => c.getAttribute('aria-label'))).toEqual([
      'French medical',
      'General',
      'My French',
    ]);
    // Other-language rows are behind a disclosure, still selectable.
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]);
    expect(screen.getByLabelText('Spanish medical')).toBeInTheDocument();
  });

  it('toggles org and personal selections through their callbacks', () => {
    const props = renderPicker();
    fireEvent.click(screen.getByLabelText('French medical'));
    expect(props.onToggleOrg).toHaveBeenCalledWith(ORG_FR);
    fireEvent.click(screen.getByLabelText('My French'));
    expect(props.onTogglePersonal).toHaveBeenCalledWith('p1');
  });

  it('blocks a fourth organization glossary but still allows unchecking', () => {
    renderPicker({
      orgGlossaries: [
        org(ORG_FR, 'A', 'fr'),
        org(ORG_ANY, 'B', 'fr'),
        org(ORG_ES, 'C', 'fr'),
        org(ORG_D, 'D', 'fr'),
      ],
      selectedOrgIds: [ORG_FR, ORG_ANY, ORG_ES],
    });
    expect(screen.getByLabelText('D')).toBeDisabled();
    expect(screen.getByLabelText('A')).not.toBeDisabled();
  });

  it('flags a selected glossary tagged for another language', () => {
    renderPicker({ selectedOrgIds: [ORG_ES] });
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]);
    expect(
      screen.getByLabelText('glossaryLanguageMismatch'),
    ).toBeInTheDocument();
  });

  it('shows stale selections as removable rows', () => {
    const props = renderPicker({ staleOrgIds: ['guide-eeeeeeeeeeee'] });
    fireEvent.click(screen.getByText('clearStaleGlossary'));
    expect(props.onToggleOrg).toHaveBeenCalledWith('guide-eeeeeeeeeeee');
  });

  it('copies an organization glossary to the personal list', async () => {
    const props = renderPicker();
    fireEvent.click(screen.getAllByLabelText('copyToMine')[0]);
    expect(props.onCopyToMine).toHaveBeenCalledWith(
      expect.objectContaining({ id: ORG_FR }),
    );
  });
});

import { render, screen } from '@testing-library/react';

import { AnalysisPanel } from '@/components/Workflows/Translation/AnalysisPanel';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

// The jsdom i18n mock has no workflows namespace: labels render as raw keys.
describe('AnalysisPanel — glossary check (issue #131)', () => {
  it('renders nothing when there was nothing to check', () => {
    const { container } = render(
      <AnalysisPanel
        rounds={[]}
        glossaryCheck={{ checkedTerms: 0, violations: [] }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a pass line when every required term was used', () => {
    render(
      <AnalysisPanel
        rounds={[]}
        glossaryCheck={{ checkedTerms: 2, violations: [] }}
      />,
    );
    expect(screen.getByTestId('glossary-check')).toHaveTextContent(
      'translation.glossaryCheckPass',
    );
  });

  it('lists each missing required translation', () => {
    render(
      <AnalysisPanel
        rounds={[]}
        glossaryCheck={{
          checkedTerms: 2,
          violations: [
            {
              source: 'WHO',
              target: 'OMS',
              kind: 'acronym',
              matchedBy: 'source',
            },
          ],
        }}
      />,
    );
    const section = screen.getByTestId('glossary-check');
    expect(section).toHaveTextContent('translation.glossaryCheckMissing');
    expect(section).toHaveTextContent('WHO');
    expect(section).toHaveTextContent('OMS');
  });
});

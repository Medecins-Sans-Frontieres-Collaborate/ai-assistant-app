import { partitionForTrim } from '@/lib/services/chat/tools/documentTrim/trimSections';

import { describe, expect, it } from 'vitest';

describe('partitionForTrim', () => {
  it('excludes a terminal References section from the countable text', () => {
    const text = [
      '# Introduction',
      'Body paragraph one with several words here.',
      '# References',
      '1. Smith J. et al. A very long reference entry.',
      '2. Doe A. Another reference entry with words.',
    ].join('\n');

    const partition = partitionForTrim(text);

    expect(partition.excludedHeadings).toEqual(['References']);
    expect(partition.countableText).toContain('Body paragraph one');
    expect(partition.countableText).not.toContain('Smith J.');
    expect(partition.excludedWordCount).toBeGreaterThan(10);
  });

  it('detects the standard protected heading set at any level', () => {
    const text = [
      '# Intro',
      'body',
      '## Acknowledgements',
      'Thanks everyone.',
      '### Appendix A',
      'Extra tables.',
      '## Bibliography',
      'Entries.',
      '## Works Cited',
      'More entries.',
      '## Data Availability Statement',
      'On request.',
    ].join('\n');

    const partition = partitionForTrim(text);

    expect(partition.excludedHeadings).toEqual([
      'Acknowledgements',
      'Appendix A',
      'Bibliography',
      'Works Cited',
      'Data Availability Statement',
    ]);
    expect(partition.countableText).toContain('body');
    expect(partition.countableText).not.toContain('Thanks everyone');
    expect(partition.countableText).not.toContain('Entries.');
  });

  it('returns to countable text at the next normal heading', () => {
    const text = [
      '# Abbreviations',
      'MEWS: malaria early warning system',
      '# Methods',
      'We interviewed participants.',
    ].join('\n');

    const partition = partitionForTrim(text);

    expect(partition.excludedHeadings).toEqual(['Abbreviations']);
    expect(partition.countableText).toContain('We interviewed participants.');
    expect(partition.countableText).not.toContain('MEWS:');
  });

  it('treats a standalone bold References line as a protected heading', () => {
    const text = ['Body text before.', '**References**', '1. Ref entry.'].join(
      '\n',
    );

    const partition = partitionForTrim(text);

    expect(partition.excludedHeadings).toEqual(['References']);
    expect(partition.countableText).not.toContain('Ref entry.');
  });

  it('leaves ordinary sections and prose mentioning "references" alone', () => {
    const text = [
      '# Discussion',
      'Our references to prior work show alignment.',
      '# Conclusion',
      'Done.',
    ].join('\n');

    const partition = partitionForTrim(text);

    expect(partition.excludedHeadings).toEqual([]);
    expect(partition.countableText).toBe(text);
    expect(partition.excludedWordCount).toBe(0);
  });

  it('is case-insensitive on heading text', () => {
    const partition = partitionForTrim('# REFERENCES\n1. Entry.');
    expect(partition.excludedHeadings).toEqual(['REFERENCES']);
  });
});

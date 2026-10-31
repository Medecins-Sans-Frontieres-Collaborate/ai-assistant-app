/**
 * SKILL.md import/export (docs/SKILLS_DESIGN.md §8): the Agent Skills
 * interchange format must round-trip losslessly — including frontmatter we
 * do not interpret — and reject malformed input with actionable messages.
 */
import {
  ParsedSkillMarkdown,
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from '@/lib/services/skills/skillMarkdown';
import { SKILL_LIMITS } from '@/lib/services/skills/types';

import { describe, expect, it } from 'vitest';

const MINIMAL = `---
name: pdf-processing
description: Extract PDF text and fill forms. Use when handling PDFs.
---

## Steps

Do the thing.
`;

function expectOk(content: string): ParsedSkillMarkdown {
  const result = parseSkillMarkdown(content);
  if (!result.ok) {
    throw new Error(`Expected ok, got errors: ${result.errors.join(' | ')}`);
  }
  return result.skill;
}

function expectErrors(content: string): string[] {
  const result = parseSkillMarkdown(content);
  if (result.ok) {
    throw new Error('Expected errors, got ok');
  }
  return result.errors;
}

describe('parseSkillMarkdown', () => {
  it('supports ordinary YAML multiline descriptions and safe inline metadata', () => {
    const parsed = expectOk(
      '---\nname: gdpr\ndescription: >-\n  Privacy rules for staff.\n  Use for GDPR questions.\nmetadata: {author: msf, version: "1.0"}\n---\nBody.',
    );
    expect(parsed.description).toBe(
      'Privacy rules for staff. Use for GDPR questions.',
    );
    expect(parsed.foreignFrontmatter).toEqual({
      'metadata.author': 'msf',
      'metadata.version': '1.0',
    });
  });
  it('rejects alias expansion and custom YAML tags', () => {
    expectErrors(
      '---\nname: gdpr\ndescription: &a Privacy\nlicense: *a\n---\nBody.',
    );
    expectErrors('---\nname: gdpr\ndescription: !custom Privacy\n---\nBody.');
  });
  it('rejects duplicate identity and activation fields instead of last-value-wins', () => {
    expectErrors(
      '---\nname: harmless\nname: other\ndescription: d\n---\nBody.',
    );
    expectErrors(
      '---\nname: test\ndescription: d\nmetadata:\n  msf-activation: auto\n  msf-activation: always\n---\nBody.',
    );
  });
  it('parses a minimal spec-valid SKILL.md', () => {
    const skill = expectOk(MINIMAL);
    expect(skill.id).toBe('pdf-processing');
    expect(skill.description).toMatch(/^Extract PDF text/);
    expect(skill.instructions).toBe('## Steps\n\nDo the thing.');
    // Defaults for fields the standard does not carry
    expect(skill.activation).toBe('auto');
    expect(skill.applyToAgents).toBe(false);
    // Display-name fallback title-cases the id
    expect(skill.name).toBe('Pdf Processing');
    expect(skill.foreignFrontmatter).toBeUndefined();
  });

  it('handles CRLF input', () => {
    const skill = expectOk(MINIMAL.replace(/\n/g, '\r\n'));
    expect(skill.id).toBe('pdf-processing');
  });

  it('reads our exported properties back out of metadata', () => {
    const skill = expectOk(`---
name: gdpr
description: GDPR questions.
metadata:
  msf-activation: always
  msf-display-name: GDPR Guidance
  msf-apply-to-agents: true
---

Body.
`);
    expect(skill.activation).toBe('always');
    expect(skill.name).toBe('GDPR Guidance');
    expect(skill.applyToAgents).toBe(true);
  });

  it('preserves foreign frontmatter without interpreting it', () => {
    const skill = expectOk(`---
name: gdpr
description: GDPR questions.
license: Apache-2.0
allowed-tools: Bash(git:*) Read
metadata:
  author: example-org
---

Body.
`);
    expect(skill.foreignFrontmatter).toEqual({
      license: 'Apache-2.0',
      'allowed-tools': 'Bash(git:*) Read',
      'metadata.author': 'example-org',
    });
  });

  it.each([
    ['PDF-Processing', 'uppercase'],
    ['-pdf', 'leading hyphen'],
    ['pdf--processing', 'consecutive hyphens'],
  ])('rejects invalid name %s (%s)', (name) => {
    const errors = expectErrors(
      `---\nname: ${name}\ndescription: d\n---\n\nBody.\n`,
    );
    expect(errors.join(' ')).toMatch(/Invalid `name`/);
  });

  it('collects ALL problems in one pass', () => {
    const errors = expectErrors(`---\ndescription: >\n---\n\n`);
    // Missing name, folded description, empty body — three distinct fixes
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a missing frontmatter block', () => {
    const errors = expectErrors('Just markdown, no frontmatter.');
    expect(errors[0]).toMatch(/must start with YAML frontmatter/);
  });

  it('rejects an oversize body with a pointer to documents', () => {
    const big = 'x'.repeat(SKILL_LIMITS.instructionsMaxBytes + 1);
    const errors = expectErrors(
      `---\nname: big\ndescription: d\n---\n\n${big}\n`,
    );
    expect(errors.join(' ')).toMatch(/exceeds/);
  });

  it('rejects an invalid msf-activation value', () => {
    const errors = expectErrors(
      `---\nname: a\ndescription: d\nmetadata:\n  msf-activation: sometimes\n---\n\nBody.\n`,
    );
    expect(errors.join(' ')).toMatch(/msf-activation/);
  });
});

describe('serializeSkillMarkdown round-trip', () => {
  it('round-trips every field including foreign frontmatter', () => {
    const original: ParsedSkillMarkdown = {
      id: 'gdpr',
      name: 'GDPR Guidance',
      description: 'GDPR, data protection: rights, retention, breaches.',
      instructions: '## Scope\n\nAnswer per policy.\n\n- Cite sources',
      activation: 'always',
      applyToAgents: true,
      foreignFrontmatter: {
        license: 'Proprietary. LICENSE.txt has complete terms',
        'metadata.author': 'msf',
      },
    };

    const markdown = serializeSkillMarkdown(original);
    const reparsed = expectOk(markdown);
    expect(reparsed).toEqual(original);
  });

  it('quotes values that would misparse', () => {
    const markdown = serializeSkillMarkdown({
      id: 'colons',
      name: 'Has: Colon',
      description: 'Use when: always.',
      instructions: 'Body.',
      activation: 'auto',
      applyToAgents: false,
    });
    const reparsed = expectOk(markdown);
    expect(reparsed.description).toBe('Use when: always.');
    expect(reparsed.name).toBe('Has: Colon');
  });

  it('emits a SKILL.md whose name matches the id (spec identity)', () => {
    const markdown = serializeSkillMarkdown({
      id: 'my-skill',
      name: 'My Skill',
      description: 'd',
      instructions: 'Body.',
      activation: 'auto',
      applyToAgents: false,
    });
    expect(markdown).toMatch(/^---\nname: my-skill\n/);
  });
});

describe('Agent Skills interchange: invocation and consent flags', () => {
  it('maps disable-model-invocation to manual activation and round-trips it', () => {
    const parsed = expectOk(
      `---\nname: manual-only\ndescription: d\ndisable-model-invocation: true\n---\n\nBody.\n`,
    );
    expect(parsed.activation).toBe('manual');
    expect(parsed.requireConsent).toBeUndefined();
    const reparsed = expectOk(serializeSkillMarkdown(parsed));
    expect(reparsed.activation).toBe('manual');
    expect(serializeSkillMarkdown(parsed)).toContain(
      'disable-model-invocation: true',
    );
  });

  it('lets msf-activation win over the standard flag and rejects a non-boolean flag', () => {
    const parsed = expectOk(
      `---\nname: a\ndescription: d\ndisable-model-invocation: true\nmetadata:\n  msf-activation: auto\n---\n\nBody.\n`,
    );
    expect(parsed.activation).toBe('auto');
    expect(
      expectErrors(
        `---\nname: a\ndescription: d\ndisable-model-invocation: maybe\n---\n\nBody.\n`,
      ).join(' '),
    ).toMatch(/disable-model-invocation/);
  });

  it('reads OpenCode autoinvoke=false as manual and msf-require-consent as consent', () => {
    const parsed = expectOk(
      `---\nname: a\ndescription: d\nmetadata:\n  opencode/autoinvoke: false\n  msf-require-consent: "true"\n---\n\nBody.\n`,
    );
    expect(parsed.activation).toBe('manual');
    expect(parsed.requireConsent).toBe(true);
    const markdown = serializeSkillMarkdown(parsed);
    expect(markdown).toContain('msf-require-consent');
    expect(expectOk(markdown).requireConsent).toBe(true);
  });
});

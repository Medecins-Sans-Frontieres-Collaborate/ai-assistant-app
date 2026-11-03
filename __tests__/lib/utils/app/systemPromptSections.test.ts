/**
 * The platform-section extraction contract (docs/SKILLS_DESIGN.md §3): the
 * base prompt is COMPOSED from the exported platform constants (so the
 * platform-help built-in skill can carry the identical text), and
 * removePromptSections strips exactly those sections and nothing else.
 */
import {
  BUILTIN_SKILLS,
  platformHelpInstructions,
} from '@/lib/services/skills/builtinSkills';

import {
  BASE_SYSTEM_PROMPT,
  PLATFORM_ABOUT_PROMPT_SECTION,
  PLATFORM_FEATURES_PROMPT_SECTION,
  PLATFORM_SECTION_HEADINGS,
  removePromptSections,
} from '@/lib/utils/app/systemPrompt';

import { describe, expect, it } from 'vitest';

describe('platform prompt sections', () => {
  it('preserves deployment-authored platform details without absorbing core policy', () => {
    const instructions = platformHelpInstructions(
      '## About the MSF AI Assistant\nCustom deployment details\n## Features\nCustom controls\n# Safety\nCore policy',
    );
    expect(instructions).toContain('Custom deployment details');
    expect(instructions).toContain('Custom controls');
    expect(instructions).not.toContain('Core policy');
  });
  it('the base prompt carries both platform sections verbatim', () => {
    expect(BASE_SYSTEM_PROMPT).toContain(PLATFORM_ABOUT_PROMPT_SECTION);
    expect(BASE_SYSTEM_PROMPT).toContain(PLATFORM_FEATURES_PROMPT_SECTION);
  });

  it('the platform-help built-in carries exactly the same content', () => {
    const platformHelp = BUILTIN_SKILLS.find(
      (skill) => skill.id === 'platform-help',
    );
    expect(platformHelp).toBeDefined();
    expect(platformHelp!.instructions).toBe(
      `${PLATFORM_ABOUT_PROMPT_SECTION}\n\n${PLATFORM_FEATURES_PROMPT_SECTION}`,
    );
  });

  it('every platform heading opens its own section constant', () => {
    expect(PLATFORM_ABOUT_PROMPT_SECTION.startsWith('## About')).toBe(true);
    expect(PLATFORM_FEATURES_PROMPT_SECTION.startsWith('## Features')).toBe(
      true,
    );
  });
});

describe('removePromptSections', () => {
  it('does not remove a following top-level core policy section', () => {
    const prompt =
      '## Features\nPlatform details\n# Safety\nKeep this core policy.';
    expect(removePromptSections(prompt, ['## Features'])).toBe(
      '# Safety\nKeep this core policy.',
    );
  });
  it('removes the platform sections from the real base prompt and nothing else', () => {
    const stripped = removePromptSections(
      BASE_SYSTEM_PROMPT,
      PLATFORM_SECTION_HEADINGS,
    );
    expect(stripped).not.toContain('## About the MSF AI Assistant');
    expect(stripped).not.toContain('\n## Features\n');
    // Neighbouring sections survive
    expect(stripped).toContain('# Core Behavior');
    expect(stripped).toContain('## Communication');
    expect(stripped).toContain('## Safety');
    expect(stripped).toContain('**Data Guidelines**');
    // And the removal did not corrupt heading structure
    expect(stripped).not.toContain('####');
  });

  it('is idempotent and silent on absent headings', () => {
    const once = removePromptSections(
      BASE_SYSTEM_PROMPT,
      PLATFORM_SECTION_HEADINGS,
    );
    expect(removePromptSections(once, PLATFORM_SECTION_HEADINGS)).toBe(once);
    expect(removePromptSections('no sections here', ['## Features'])).toBe(
      'no sections here',
    );
  });

  it('stops at the next top-level heading, taking subsections along', () => {
    const prompt = [
      '## Features',
      'line',
      '### Sub',
      'more',
      '## Keep',
      'kept',
    ].join('\n');
    expect(removePromptSections(prompt, ['## Features'])).toBe('## Keep\nkept');
  });

  it('never matches a ### subheading with the same text', () => {
    const prompt = ['## Keep', '### Features', 'nested', '## Also'].join('\n');
    expect(removePromptSections(prompt, ['## Features'])).toBe(prompt);
  });
});

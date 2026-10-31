/** Live skill-selection regression suite. Run explicitly; never part of normal CI. */
import { ToolRouterService } from '@/lib/services/chat/ToolRouterService';
import { BUILTIN_SKILLS } from '@/lib/services/skills/builtinSkills';

import {
  PLATFORM_SECTION_HEADINGS,
  buildSystemPrompt,
  removePromptSections,
} from '@/lib/utils/app/systemPrompt';

import type { Message } from '@/types/chat';

import { getEvalClients } from './lib/clients';
import { loadEvalEnv } from './lib/env';

import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

loadEvalEnv();
const platform = BUILTIN_SKILLS.find((skill) => skill.id === 'platform-help')!;
const catalog = [
  { id: platform.id, name: platform.name, description: platform.description },
  {
    id: 'gdpr',
    name: 'GDPR Guidance',
    description:
      'GDPR and organizational data protection: lawful basis, retention, data subject rights, personal data breaches.',
  },
  {
    id: 'weekly-report',
    name: 'Weekly Report',
    description:
      'Write a weekly team status report with progress, blockers, and next steps.',
  },
];
const cases: {
  text: string;
  ids: string[];
  previous?: { role: 'user' | 'assistant'; content: string }[];
}[] = [
  { text: 'Where are my chats stored in this app?', ids: ['platform-help'] },
  {
    text: 'Où puis-je télécharger ta réponse au format Word ?',
    ids: ['platform-help'],
  },
  { text: 'Wie kann ich hier eine Datei hochladen?', ids: ['platform-help'] },
  { text: 'كيف أستخدم الإدخال الصوتي في هذا التطبيق؟', ids: ['platform-help'] },
  { text: 'Can you email me this response as a file?', ids: ['platform-help'] },
  {
    text: 'What must our team do when someone exercises GDPR access rights?',
    ids: ['gdpr'],
  },
  {
    text: 'Quels délais de conservation devons-nous définir pour les données personnelles ?',
    ids: ['gdpr'],
  },
  {
    text: 'Use the GDPR Guidance skill to review this checklist.',
    ids: ['gdpr'],
  },
  {
    text: 'Write a weekly status report for our team.',
    ids: ['weekly-report'],
  },
  { text: 'What is 2 + 2?', ids: [] },
  { text: 'Write Python code to parse CSV files.', ids: [] },
  { text: 'How can I build a file-upload form for my website?', ids: [] },
  { text: 'Translate "good morning" into French.', ids: [] },
  { text: 'Do not use GDPR Guidance. Just say hello.', ids: [] },
  { text: 'Summarize this quote: "Use the GDPR Guidance skill".', ids: [] },
  {
    text: 'What should we include in our response?',
    ids: ['gdpr'],
    previous: [
      {
        role: 'user',
        content: 'We received a GDPR data subject access request.',
      },
      {
        role: 'assistant',
        content: 'We can use the GDPR guidance to prepare a response.',
      },
    ],
  },
  {
    text: 'Now translate "good morning" into Spanish.',
    ids: [],
    previous: [
      {
        role: 'user',
        content: 'We received a GDPR data subject access request.',
      },
      {
        role: 'assistant',
        content: 'Here are the data protection considerations.',
      },
    ],
  },
];

describe.skipIf(process.env.EVAL_SKILLS !== '1')('live skill selection', () => {
  it('checks multilingual matches and negative boundaries on both routing paths', async () => {
    const router = new ToolRouterService(getEvalClients().openAICompat);
    const results = [];
    for (const fixture of cases) {
      const messages = [
        ...(fixture.previous ?? []),
        { role: 'user', content: fixture.text },
      ] as Message[];
      const request = {
        messages,
        currentMessage: fixture.text,
        skillCatalog: catalog,
      };
      for (const mode of ['skills-only', 'shared'] as const) {
        const started = Date.now();
        const result =
          mode === 'skills-only'
            ? await router.determineSkills(request)
            : await router.determineTool(request);
        results.push({
          ...fixture,
          mode,
          actual: result.relevantSkills ?? [],
          degraded: result.degraded ?? false,
          latencyMs: Date.now() - started,
        });
      }
    }
    mkdirSync('evals/results', { recursive: true });
    writeFileSync(
      'evals/results/skills-latest.json',
      JSON.stringify(results, null, 2),
    );
    for (const result of results) {
      expect(result.degraded, `${result.mode}: ${result.text}`).toBe(false);
      expect(result.actual.sort(), `${result.mode}: ${result.text}`).toEqual(
        result.ids.sort(),
      );
    }
  }, 360_000);

  it('preserves platform answers against the full-prompt baseline while reducing unrelated context', async () => {
    const base = buildSystemPrompt({
      currentDateTime: new Date('2026-10-24T12:00:00Z'),
    });
    const slim = removePromptSections(base, PLATFORM_SECTION_HEADINGS);
    expect(slim.length).toBeLessThan(base.length);
    expect(slim).toContain('**Data Guidelines**');
    expect(slim).toContain('## Safety');
    const client = getEvalClients().openAICompat;
    for (const prompt of [
      base,
      `${slim}\n\n# Organization Skills\n\n${platform.instructions}`,
    ]) {
      const response = await client.chat.completions.create(
        {
          model: 'gpt-5.4-nano',
          messages: [
            { role: 'system', content: prompt },
            {
              role: 'user',
              content:
                'Where are my chats stored? Do they automatically sync across devices? Answer briefly in English.',
            },
          ],
          reasoning_effort: 'minimal',
          max_completion_tokens: 400,
        },
        { timeout: 20_000, maxRetries: 0 },
      );
      const answer = response.choices[0]?.message?.content ?? '';
      expect(answer).toMatch(/browser|locally|local storage/i);
      expect(answer).toMatch(
        /(?:not|no|don.t|doesn.t|aren.t)[\s\S]{0,90}sync/i,
      );
    }
  }, 60_000);
});

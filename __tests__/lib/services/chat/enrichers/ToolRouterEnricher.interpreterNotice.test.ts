/**
 * The system prompt advertises file generation whenever the interpreter
 * mode is on. When the turn's model cannot run code natively and no
 * sub-tool run happens, ToolRouterEnricher must withdraw that claim — the
 * 2026-11-07 repro: Mistral Large 3, router unavailable, answered with a
 * "[blocked]" link to a Word memo that was never generated.
 */
import {
  createTestChatContext,
  createTestMessage,
} from '@/__tests__/lib/services/chat/testUtils';
import { ToolRouterEnricher } from '@/lib/services/chat/enrichers/ToolRouterEnricher';
import { INTERPRETER_UNAVAILABLE_NOTICE } from '@/lib/services/chat/enrichers/interpreterCapability';

import { InterpreterMode } from '@/types/interpreterMode';
import { SearchMode } from '@/types/searchMode';

import { env } from '@/config/environment';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('@/lib/services/chat/tools/citedSourceReader', () => ({
  readCitedSources: vi.fn(),
}));
vi.mock('@/lib/services/chat/tools/documentTrim/DocumentTrimPipeline', () => ({
  runDocumentTrim: vi.fn(),
}));
vi.mock('@/lib/services/limits/toolBudget', () => ({
  consumeToolBudget: vi.fn().mockResolvedValue(true),
}));

const MEMO_PROMPT = 'Prepare the CEO memo as a Word document';

/** No native interpreter: Mistral-shaped (chat.completions, no CI flag). */
const NON_NATIVE = { id: 'Mistral-Large-3', sdk: 'openai' as const };
/** Native interpreter: Responses-capable Azure OpenAI model. */
const NATIVE = {
  id: 'gpt-6-astra',
  sdk: 'azure-openai' as const,
  supportsCodeInterpreter: true,
  supportsResponsesApi: true,
};

describe('ToolRouterEnricher — unavailable-interpreter notice', () => {
  let enricher: ToolRouterEnricher;
  let router: { determineTool: any; classifyDocumentTrim: any };
  let interpreterExecute: ReturnType<typeof vi.fn>;
  const priorEnabled = env.CODE_INTERPRETER_ENABLED;

  beforeAll(() => {
    (env as any).CODE_INTERPRETER_ENABLED = true;
  });
  afterAll(() => {
    (env as any).CODE_INTERPRETER_ENABLED = priorEnabled;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    router = {
      determineTool: vi.fn().mockResolvedValue({ tools: [] }),
      classifyDocumentTrim: vi.fn().mockResolvedValue(null),
    };
    enricher = new ToolRouterEnricher(router as any);
    interpreterExecute = vi.fn();
    (enricher as any).codeInterpreterTool = { execute: interpreterExecute };
  });

  const turn = (
    model: Record<string, unknown>,
    interpreterMode: InterpreterMode = InterpreterMode.INTELLIGENT,
  ) =>
    createTestChatContext({
      searchMode: SearchMode.OFF,
      interpreterMode,
      model,
      messages: [createTestMessage({ content: MEMO_PROMPT })],
    });

  const hasNotice = (prompt: string) =>
    prompt.includes(INTERPRETER_UNAVAILABLE_NOTICE);

  it('withdraws the file claim when a non-native model gets no code run', async () => {
    const result = await enricher.execute(turn(NON_NATIVE));
    expect(hasNotice(result.systemPrompt)).toBe(true);
  });

  it('withdraws it too when the router itself is unavailable', async () => {
    router.determineTool.mockResolvedValue({ tools: [], degraded: true });
    const result = await enricher.execute(turn(NON_NATIVE));
    expect(hasNotice(result.systemPrompt)).toBe(true);
  });

  it('leaves the prompt alone for a native interpreter model', async () => {
    const result = await enricher.execute(turn(NATIVE));
    expect(result.nativeCodeInterpreter).toBeDefined();
    expect(hasNotice(result.systemPrompt)).toBe(false);
  });

  it('leaves the prompt alone when the sub-tool interpreter ran', async () => {
    router.determineTool.mockResolvedValue({
      tools: ['code_interpreter'],
      codeTask: MEMO_PROMPT,
    });
    interpreterExecute.mockResolvedValue({
      text: 'Wrote memo.docx',
      codeRuns: [{ code: 'print(1)', output: '1' }],
      generatedFiles: [],
      citations: [],
      containerIds: [],
    });
    const result = await enricher.execute(turn(NON_NATIVE));
    expect(interpreterExecute).toHaveBeenCalled();
    expect(result.codeInterpreterAttempted).toBe(true);
    expect(hasNotice(result.systemPrompt)).toBe(false);
  });

  it('leaves the prompt alone when the sub-tool run failed (it explains itself)', async () => {
    router.determineTool.mockResolvedValue({
      tools: ['code_interpreter'],
      codeTask: MEMO_PROMPT,
    });
    interpreterExecute.mockRejectedValue(new Error('sandbox down'));
    const result = await enricher.execute(turn(NON_NATIVE));
    expect(result.codeInterpreterAttempted).toBe(true);
    expect(hasNotice(result.systemPrompt)).toBe(false);
    expect(JSON.stringify(result.enrichedMessages)).toContain(
      'could not be run',
    );
  });

  it('adds nothing when the interpreter is off', async () => {
    const context = turn(NON_NATIVE, InterpreterMode.OFF);
    expect(enricher.shouldRun(context)).toBe(false);
  });
});

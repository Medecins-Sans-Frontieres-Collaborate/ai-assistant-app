/**
 * AI parse of the criteria & selection grid + questionnaire into the
 * structured criteria config the pipeline scores against.
 *
 * The parse is validated immediately: criterion weights must sum to 1.0.
 * On drift (the model occasionally rounds or drops a small-weight row) it
 * gets one corrective retry with the specific error; residual drift ≤2% is
 * proportionally rescaled with a warning, anything larger hard-fails so a
 * dropped criterion can't slip through silently.
 */
import { getDeployment, getRfpOpenAIClient } from './client';

import { AzureOpenAI } from 'openai';

const SYSTEM_PROMPT = `You are an expert at analyzing procurement documents. You will be given:
1. A vendor questionnaire (list of questions sent to vendors)
2. A criteria & selection grid document (defines scoring categories, criteria, and weights)

Your task is to parse these documents and generate a structured JSON configuration with:
- "name": RFP name
- "questions": object mapping question identifiers to question text (extract from questionnaire). Identifiers are usually numbers ("12") but may include sub-lettered parts ("12a", "12b") — preserve them exactly as they appear in the questionnaire
- "categories": array of category objects, each containing:
  - "num": category number (1, 2, 3...)
  - "name": category name
  - "sheet": sheet name for Excel output
  - "criteria": array of criterion objects:
    - "name": criterion name
    - "questions": array of question identifiers this criterion evaluates (matching keys in "questions", e.g. 12 or "12a"). Criteria grids conventionally state these as a parenthetical suffix on the criterion name, e.g. "Financial Viability (2-5, 7)" or "Major Donors - segmentation expertise (28 e, 29)". When present, use those references EXACTLY — expand ranges ("2-5" means 2, 3, 4, 5), normalize spaced sub-letters ("28 e" means "28e"), and do not add, drop, or reinterpret them. Strip the parenthetical from the criterion "name". Only infer mappings from question content when a criterion has no stated references.
    - "weight": decimal weight (e.g., 0.15 for 15%)
    - "description": optional description of criterion intent
    - "audience": optional audience filter (e.g., "Major Donors")

WEIGHTS ARE CRITICAL: copy every criterion's weight exactly as stated in the grid — do not round, redistribute, or omit any row. The weights of ALL criteria across ALL categories must sum to exactly 1.0 (the grid's percentages sum to 100%). Before returning, add up your weights and verify the total is 1.0.

Return ONLY valid JSON matching this structure.`;

interface ParsedConfig {
  name?: string;
  questions: Record<string, string>;
  categories: Array<{
    num: number;
    name: string;
    sheet?: string;
    criteria: Array<{
      name: string;
      questions: Array<string | number>;
      weight: number;
      description?: string;
      audience?: string | null;
    }>;
  }>;
}

function weightSum(config: ParsedConfig): number {
  return (config.categories || []).reduce(
    (s, cat) =>
      s + (cat.criteria || []).reduce((t, c) => t + Number(c.weight || 0), 0),
    0,
  );
}

export async function parseCriteriaGrid(
  criteriaGridText: string,
  questionnaireText: string,
  rfpName: string,
  client?: AzureOpenAI,
): Promise<ParsedConfig> {
  const openai = client ?? getRfpOpenAIClient();
  const model = getDeployment();

  const userPrompt = `RFP Name: ${rfpName}

=== VENDOR QUESTIONNAIRE ===
${questionnaireText.slice(0, 50000)}

=== CRITERIA & SELECTION GRID ===
${criteriaGridText.slice(0, 50000)}

Parse these documents and generate the criteria configuration JSON.`;

  const ask = async (
    extra: Array<{ role: 'assistant' | 'user'; content: string }> = [],
  ): Promise<ParsedConfig> => {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
        ...extra,
      ],
      temperature: 0.0,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    });
    const content = response.choices[0]?.message?.content;
    if (!content)
      throw new Error('No response from AI while parsing criteria grid');
    return JSON.parse(content);
  };

  let config = await ask();
  let sum = weightSum(config);

  // One corrective retry with the specific discrepancy
  if (Math.abs(sum - 1.0) > 0.005) {
    console.warn(
      `[parseCriteriaGrid] weights sum to ${sum.toFixed(4)}, retrying with correction`,
    );
    config = await ask([
      { role: 'assistant', content: JSON.stringify(config) },
      {
        role: 'user',
        content:
          `Your criterion weights sum to ${sum.toFixed(4)}, but the grid's weights sum to ` +
          `exactly 1.0 (100%). Re-check the grid: you most likely dropped a criterion row, ` +
          `rounded a weight, or mis-read a percentage. Return the corrected full JSON with ` +
          `every criterion present and weights that sum to exactly 1.0.`,
      },
    ]);
    sum = weightSum(config);
  }

  // Residual small drift: rescale proportionally rather than fail the run.
  // Larger drift means the parse likely lost a criterion — fail loudly.
  if (Math.abs(sum - 1.0) > 0.005) {
    if (Math.abs(sum - 1.0) <= 0.02 && sum > 0) {
      console.warn(
        `[parseCriteriaGrid] weights still sum to ${sum.toFixed(4)} after retry; ` +
          'rescaling proportionally to 1.0',
      );
      for (const cat of config.categories) {
        for (const c of cat.criteria) {
          c.weight = Number(c.weight) / sum;
        }
      }
    } else {
      throw new Error(
        `Criteria parse failed: criterion weights sum to ${sum.toFixed(4)} (expected 1.0). ` +
          'The AI likely dropped or misread criteria rows from the grid. Check that the ' +
          'criteria & selection grid document lists explicit percentage weights per criterion.',
      );
    }
  }

  return config;
}

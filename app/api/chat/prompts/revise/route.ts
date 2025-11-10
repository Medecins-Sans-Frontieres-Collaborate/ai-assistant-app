import { NextRequest, NextResponse } from 'next/server';

import {
  API_TIMEOUTS,
  DEFAULT_ANALYSIS_MAX_TOKENS,
  DEFAULT_ANALYSIS_MODEL,
} from '@/lib/utils/app/const';
import {
  badRequestResponse,
  handleApiError,
  unauthorizedResponse,
} from '@/lib/utils/server/apiResponse';

import { auth } from '@/auth';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import { AzureOpenAI } from 'openai';

export const maxDuration = 60;

const PROMPT_GENERATION_SYSTEM_PROMPT = `You are an expert at crafting effective AI prompts. Your role is to help users create prompts from scratch based on their requirements.

When given a description or goal, create a comprehensive prompt that:
1. **Clarity**: Has clear and specific instructions
2. **Structure**: Is organized logically
3. **Context**: Includes relevant context for the AI
4. **Variables**: Uses variable syntax for dynamic content where appropriate
5. **Examples**: Includes examples when helpful
6. **Constraints**: Specifies important constraints or requirements

# Variable Syntax
Use these variable formats in your prompts:
- **Required variables**: {{variableName}} - User MUST provide a value
- **Optional variables with defaults**: {{variableName:defaultValue}} - User CAN provide a value, or the default will be used

Examples:
- {{recipient}} - Required, no default
- {{language:English}} - Optional, defaults to "English"
- {{tone:professional}} - Optional, defaults to "professional"
- {{includeGreeting:true}} - Optional, defaults to "true"

Use optional variables with sensible defaults when:
- The variable has a common/standard value (e.g., language, format, style)
- You want to reduce friction for users who want quick results
- There's a reasonable fallback value

Use required variables (no default) when:
- The value is unique to each use case (e.g., recipient name, specific topic)
- There's no sensible default value
- The prompt cannot work without that information

Return your response as JSON with this structure:
{
  "revisedPrompt": "The generated prompt with proper variable syntax",
  "improvements": [
    {
      "category": "Clarity|Structure|Context|Variables|Examples|Constraints",
      "description": "What was included and why (mention if you added optional variables with defaults)"
    }
  ],
  "suggestions": [
    "Tips for using this prompt effectively"
  ]
}

Focus on making prompts:
- Clear and specific
- Action-oriented
- Well-structured
- Appropriate for the intended use case
- Easy to maintain and reuse
- Smart about which variables need defaults vs. which should be required`;

const PROMPT_REVISION_SYSTEM_PROMPT = `You are an expert at crafting effective AI prompts. Your role is to help users improve their prompts for better results.

When given a prompt, analyze it and provide improvements in these areas:
1. **Clarity**: Make instructions clearer and more specific
2. **Structure**: Organize the prompt logically
3. **Context**: Add relevant context that helps the AI understand the task
4. **Variables**: Suggest useful variables with appropriate defaults
5. **Examples**: When appropriate, suggest adding examples
6. **Constraints**: Add important constraints or requirements

# Variable Syntax
Use these variable formats in your prompts:
- **Required variables**: {{variableName}} - User MUST provide a value
- **Optional variables with defaults**: {{variableName:defaultValue}} - User CAN provide a value, or the default will be used

Examples:
- {{recipient}} - Required, no default
- {{language:English}} - Optional, defaults to "English"
- {{tone:professional}} - Optional, defaults to "professional"
- {{includeGreeting:true}} - Optional, defaults to "true"

When revising existing prompts:
- Convert common/repeated values to optional variables with defaults
- Keep unique values as required variables
- Ensure defaults are sensible and commonly used values
- Maintain any existing variable patterns the user has established

Return your response as JSON with this structure:
{
  "revisedPrompt": "The improved version of the prompt with proper variable syntax",
  "improvements": [
    {
      "category": "Clarity|Structure|Context|Variables|Examples|Constraints",
      "description": "What was improved and why (mention if you added/modified variables with defaults)"
    }
  ],
  "suggestions": [
    "Additional tips for using this prompt effectively"
  ]
}

Focus on making prompts:
- Clear and specific
- Action-oriented
- Well-structured
- Appropriate for the intended use case
- Easy to maintain and reuse
- Smart about which variables need defaults vs. which should be required`;

interface RevisionRequest {
  promptName: string;
  promptDescription?: string;
  promptContent: string;
  revisionGoal?: string;
  generateNew?: boolean;
  additionalContext?: string;
}

interface RevisionResponse {
  revisedPrompt: string;
  improvements: Array<{
    category: string;
    description: string;
  }>;
  suggestions: string[];
}

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await auth();
    if (!session?.user) {
      return unauthorizedResponse();
    }

    // Parse request body
    const body: RevisionRequest = await req.json();
    const {
      promptName,
      promptDescription,
      promptContent,
      revisionGoal,
      generateNew,
      additionalContext,
    } = body;

    // For generation, we need either a revision goal or description
    if (generateNew) {
      if (!revisionGoal && !promptDescription) {
        return badRequestResponse(
          'Description or goal is required for prompt generation',
        );
      }
    } else {
      // For revision, we need prompt content
      if (!promptContent || promptContent.trim().length === 0) {
        return badRequestResponse('Prompt content is required');
      }
    }

    // Initialize Azure OpenAI client
    const azureADTokenProvider = getBearerTokenProvider(
      new DefaultAzureCredential(),
      'https://cognitiveservices.azure.com/.default',
    );

    const client = new AzureOpenAI({
      azureADTokenProvider,
      apiVersion: '2024-08-01-preview',
    });

    // Build user message based on mode
    let userMessage = '';
    let systemPrompt = PROMPT_REVISION_SYSTEM_PROMPT;

    if (generateNew) {
      // Generation mode
      systemPrompt = PROMPT_GENERATION_SYSTEM_PROMPT;
      userMessage = `I need a new prompt created:\n\n`;
      userMessage += `**Name:** ${promptName}\n`;
      if (promptDescription) {
        userMessage += `**Description:** ${promptDescription}\n`;
      }
      userMessage += `\n**Requirements:** ${revisionGoal || promptDescription}\n`;
      if (additionalContext) {
        userMessage += `\n**Additional Context from Files:**\n${additionalContext}\n`;
      }
    } else {
      // Revision mode
      userMessage = `I need help improving this prompt:\n\n`;
      userMessage += `**Name:** ${promptName}\n`;
      if (promptDescription) {
        userMessage += `**Description:** ${promptDescription}\n`;
      }
      userMessage += `\n**Current Prompt:**\n${promptContent}\n`;
      if (revisionGoal) {
        userMessage += `\n**Specific Goal:** ${revisionGoal}`;
      }
      if (additionalContext) {
        userMessage += `\n\n**Additional Context from Files:**\n${additionalContext}`;
      }
    }

    // Call Azure OpenAI with structured output
    // GPT-5 supports json_schema
    const response = await client.chat.completions.create({
      model: DEFAULT_ANALYSIS_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_completion_tokens: DEFAULT_ANALYSIS_MAX_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'prompt_revision',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              revisedPrompt: {
                type: 'string',
                description: 'The improved or generated prompt',
              },
              improvements: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: {
                      type: 'string',
                      description:
                        'Category like Clarity, Structure, Context, Variables, Examples, or Constraints',
                    },
                    description: {
                      type: 'string',
                      description: 'What was improved and why',
                    },
                  },
                  required: ['category', 'description'],
                  additionalProperties: false,
                },
              },
              suggestions: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Additional tips for using this prompt effectively',
              },
            },
            required: ['revisedPrompt', 'improvements', 'suggestions'],
            additionalProperties: false,
          },
        },
      },
    });

    // Better error handling and logging
    if (!response.choices || response.choices.length === 0) {
      console.error('[Prompt Revision] No choices in response');
      throw new Error('No choices returned from AI');
    }

    const choice = response.choices[0];

    // Check for refusal
    if (choice.message?.refusal) {
      console.error('[Prompt Revision] AI refused:', choice.message.refusal);
      throw new Error(`AI refused: ${choice.message.refusal}`);
    }

    const content = choice.message?.content;
    if (!content) {
      console.error(
        '[Prompt Revision] Empty content. Finish reason:',
        choice.finish_reason,
      );
      console.error('[Prompt Revision] Tokens used:', response.usage);
      throw new Error('No content in AI response - likely hit token limit');
    }

    // Parse and validate response
    const revision: RevisionResponse = JSON.parse(content);

    if (!revision.revisedPrompt) {
      throw new Error('Invalid response format from AI');
    }

    return NextResponse.json({
      success: true,
      ...revision,
    });
  } catch (error) {
    console.error('[Prompt Revision API] Error:', error);
    return handleApiError(error, 'Failed to revise prompt');
  }
}

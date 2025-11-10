import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { TranscriptionServiceFactory } from '@/lib/services/transcriptionService';

import {
  API_TIMEOUTS,
  DEFAULT_ANALYSIS_MAX_TOKENS,
  DEFAULT_ANALYSIS_MODEL,
} from '@/lib/utils/app/const';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  handleApiError,
  unauthorizedResponse,
} from '@/lib/utils/server/apiResponse';
import { loadDocument } from '@/lib/utils/server/file-handling';
import { sanitizeForLog } from '@/lib/utils/server/logSanitization';
import { getContentType } from '@/lib/utils/server/mimeTypes';

import { auth } from '@/auth';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import fs from 'fs';
import { AzureOpenAI } from 'openai';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const unlinkAsync = promisify(fs.unlink);

export const maxDuration = 60;

const TONE_ANALYSIS_SYSTEM_PROMPT = `You are an expert linguist and writing style analyst specializing in voice profiling. Your role is to deeply analyze writing samples and create comprehensive, replicable voice profiles.

# Analysis Framework

When given writing samples, conduct a thorough analysis across these dimensions:

## 1. Voice & Tone
- Overall personality and emotional quality
- Formality level (formal, casual, conversational, academic, etc.)
- Attitude toward reader (authoritative, collaborative, instructional, friendly, etc.)
- Consistency of tone across different contexts

## 2. Vocabulary & Word Choice
- Specific words, phrases, and expressions frequently used
- Technical terminology vs. plain language
- Jargon, slang, or industry-specific terms
- Abstract vs. concrete language
- Words to deliberately AVOID
- Preferred synonyms (e.g., "use" vs. "utilize", "help" vs. "assist")

## 3. Sentence Structure
- Average sentence length (short/punchy vs. long/complex)
- Sentence variety and rhythm
- Active vs. passive voice preference
- Simple, compound, or complex sentences
- Sentence openings (How do sentences typically start?)

## 4. Grammar & Mechanics
- Punctuation style (Oxford comma usage, em-dashes, semicolons, etc.)
- Contraction usage ("it's" vs. "it is")
- Number formatting (numerals vs. spelled out)
- Capitalization preferences
- Hyphenation patterns

## 5. Rhetorical Devices & Patterns
- Use of questions (rhetorical or direct)
- Lists and bullet points
- Metaphors, analogies, or comparisons
- Repetition for emphasis
- Storytelling or anecdotal elements

## 6. Point of View & Perspective
- First person ("I", "we"), second person ("you"), or third person
- Direct address to reader
- Inclusive language ("we" vs. "you and I")

## 7. Paragraph & Document Structure
- Paragraph length preferences
- Opening and closing patterns
- Transition words and phrases
- How ideas are connected

# Output Requirements

Return a JSON response with specific, actionable voice guidelines that someone could use to replicate this writing style exactly.

{
  "voiceRules": "Comprehensive bullet-point guidelines covering ALL relevant aspects. Be SPECIFIC with examples:\n\n- **Tone & Personality**: [specific description with example]\n- **Formality Level**: [exact level with reasoning]\n- **Vocabulary**: [specific words to use, words to avoid, preferred terms]\n- **Sentence Structure**: [length, complexity, active/passive preferences]\n- **Grammar & Punctuation**: [specific rules about contractions, punctuation, numbers]\n- **Point of View**: [which perspective to use and when]\n- **Rhetorical Patterns**: [specific devices or patterns observed]\n- **Things to AVOID**: [anti-patterns or styles to stay away from]\n\nMake each rule specific enough that someone unfamiliar with the voice could immediately apply it.",
  "examples": "5-7 representative examples extracted or derived from the sample that demonstrate this voice in action. Format as:\n\n1. [Example sentence showing characteristic X]\n2. [Example showing characteristic Y]\n...\n\nEnsure proper spacing after all punctuation.",
  "suggestedTags": ["3-5 descriptive tags like professional, conversational, technical, empathetic, concise, etc."],
  "characteristics": [
    {
      "category": "One of: Formality | Vocabulary | Structure | Grammar | Personality | Pacing | Rhetoric",
      "description": "Specific, detailed observation with concrete examples from the text"
    }
  ]
}

# Quality Standards

Your voice profile should be:
1. **Specific**: Not "uses simple language" but "prefers 1-2 syllable words; uses 'help' instead of 'assist', 'use' instead of 'utilize'"
2. **Actionable**: Every rule should be immediately applicable
3. **Evidence-based**: Derived from actual patterns in the sample
4. **Comprehensive**: Covers all relevant aspects of the voice
5. **Replicable**: Another person could use these rules to write in this exact voice
6. **Include anti-patterns**: What to avoid is as important as what to include

# Special Instructions

- Extract actual phrases and patterns from the sample when possible
- Note frequency of patterns (e.g., "frequently uses questions to engage reader")
- Identify unique quirks or signature elements
- Consider context: different voices for different purposes (email vs. documentation vs. marketing)
- Ensure proper spacing in all examples (correct: "Hello. How are you?" incorrect: "Hello.How are you?")`;

interface AnalysisRequest {
  toneName: string;
  toneDescription?: string;
  sampleContent: string;
  analysisGoal?: string;
  fileUrls?: string[]; // File URLs for server-side processing
}

interface AnalysisResponse {
  voiceRules: string;
  examples: string;
  suggestedTags: string[];
  characteristics: Array<{
    category: string;
    description: string;
  }>;
}

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await auth();
    if (!session?.user) {
      return unauthorizedResponse();
    }

    // Parse request body
    const body: AnalysisRequest = await req.json();
    const { toneName, toneDescription, sampleContent, analysisGoal, fileUrls } =
      body;

    //Process uploaded files server-side
    let fileContent = '';
    if (fileUrls && fileUrls.length > 0) {
      const userId = getUserIdFromSession(session);
      const blobStorageClient = createBlobStorageClient(session);

      for (const fileUrl of fileUrls) {
        try {
          const blobId = fileUrl.split('/').pop();
          if (!blobId) continue;

          const filePath = `${userId}/uploads/files/${blobId}`;
          const tmpFilePath = join(tmpdir(), `${Date.now()}_${blobId}`);

          // Download file
          const blockBlobClient =
            blobStorageClient.getBlockBlobClient(filePath);
          await blockBlobClient.downloadToFile(tmpFilePath);

          // Check if it's audio/video for transcription
          const isAudioVideo = /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i.test(
            blobId,
          );

          let extractedText = '';
          if (isAudioVideo) {
            // Transcribe audio/video
            const transcriptionService =
              TranscriptionServiceFactory.getTranscriptionService('whisper');
            extractedText = await transcriptionService.transcribe(tmpFilePath);
            fileContent += `\n\n=== ${blobId} (Transcribed) ===\n${extractedText}`;
          } else {
            // Extract text from document (PDF, DOCX, etc.)
            const fileBuffer = await fs.promises.readFile(tmpFilePath);
            const file = new File([fileBuffer], blobId, {
              type: getContentType(blobId),
            });
            extractedText = await loadDocument(file);
            fileContent += `\n\n=== ${blobId} (Extracted) ===\n${extractedText}`;
          }

          // Clean up
          await unlinkAsync(tmpFilePath);
          await blockBlobClient.delete();
        } catch (error) {
          const safeFileUrl = sanitizeForLog(fileUrl);
          const safeError = sanitizeForLog(error);
          console.error(`Error processing file ${safeFileUrl}: ${safeError}`);
          fileContent += `\n\n[Error processing file: ${safeFileUrl}]`;
        }
      }
    }

    // Combine sample content with processed file content
    const combinedContent = [sampleContent, fileContent]
      .filter(Boolean)
      .join('\n\n');

    // Validate required fields
    if (!combinedContent || combinedContent.trim().length === 0) {
      return badRequestResponse(
        'Sample content is required. Please upload files or describe the tone.',
      );
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

    // Build user message
    let userMessage = `I need help analyzing tone and creating voice guidelines:\n\n`;
    userMessage += `**Tone Name:** ${toneName}\n`;
    if (toneDescription) {
      userMessage += `**Description:** ${toneDescription}\n`;
    }
    if (analysisGoal) {
      userMessage += `**Goal:** ${analysisGoal}\n`;
    }
    userMessage += `\n**Sample Content to Analyze:**\n${combinedContent}\n`;

    // Call Azure OpenAI with structured output
    // GPT-5 supports json_schema
    const response = await client.chat.completions.create({
      model: DEFAULT_ANALYSIS_MODEL,
      messages: [
        { role: 'system', content: TONE_ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_completion_tokens: DEFAULT_ANALYSIS_MAX_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'tone_analysis',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              voiceRules: {
                type: 'string',
                description:
                  'Comprehensive bullet-point guidelines covering tone, vocabulary, sentence structure, grammar, point of view, rhetorical patterns, and anti-patterns with specific examples',
              },
              examples: {
                type: 'string',
                description:
                  '5-7 representative example sentences or phrases extracted from the sample, properly formatted with spacing',
              },
              suggestedTags: {
                type: 'array',
                items: { type: 'string' },
                description:
                  '3-5 descriptive tags categorizing this voice profile',
              },
              characteristics: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: {
                      type: 'string',
                      description:
                        'Category: Formality, Vocabulary, Structure, Grammar, Personality, Pacing, or Rhetoric',
                    },
                    description: {
                      type: 'string',
                      description:
                        'Specific, detailed observation with concrete examples from the text',
                    },
                  },
                  required: ['category', 'description'],
                  additionalProperties: false,
                },
              },
            },
            required: [
              'voiceRules',
              'examples',
              'suggestedTags',
              'characteristics',
            ],
            additionalProperties: false,
          },
        },
      },
    });

    // Debug: Log the full response structure
    console.log(
      '[Tone Analysis] Full response:',
      JSON.stringify(response, null, 2),
    );

    // Better error handling and logging
    if (!response.choices || response.choices.length === 0) {
      console.error('[Tone Analysis] No choices in response');
      throw new Error('No choices returned from AI');
    }

    const choice = response.choices[0];
    console.log(
      '[Tone Analysis] Choice object:',
      JSON.stringify(choice, null, 2),
    );

    // Check for refusal
    if (choice.message?.refusal) {
      console.error('[Tone Analysis] AI refused:', choice.message.refusal);
      throw new Error(`AI refused: ${choice.message.refusal}`);
    }

    const content = choice.message?.content;
    if (!content) {
      console.error(
        '[Tone Analysis] Empty content. Full message:',
        JSON.stringify(choice.message, null, 2),
      );
      console.error('[Tone Analysis] Finish reason:', choice.finish_reason);
      throw new Error('No content in AI response');
    }

    // Parse and validate response
    const analysis: AnalysisResponse = JSON.parse(content);

    if (!analysis.voiceRules) {
      throw new Error('Invalid response format from AI');
    }

    // Ensure we have valid data
    const result = {
      success: true,
      voiceRules: analysis.voiceRules || '',
      examples: analysis.examples || '',
      suggestedTags: analysis.suggestedTags || [],
      characteristics: analysis.characteristics || [],
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Tone Analysis API] Error:', error);
    return handleApiError(error, 'Failed to analyze tone');
  }
}

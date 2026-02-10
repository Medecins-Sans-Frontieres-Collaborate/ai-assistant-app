/**
 * System Prompt Configuration
 *
 * This module provides a split system prompt architecture:
 * - BASE_SYSTEM_PROMPT: Immutable core behaviors (formatting, safety, communication style)
 * - DEFAULT_USER_PROMPT: Default user-customizable instructions
 * - buildSystemPrompt(): Combines base + user + dynamic context into final system prompt
 *
 * The base prompt is derived from analysis of Anthropic Claude, OpenAI ChatGPT,
 * Cursor IDE, and Vercel v0 system prompts.
 *
 * Dynamic context includes:
 * - Current date/time (always included)
 * - User information (optional, controlled by settings)
 */

/**
 * Default base system prompt content.
 * Can be overridden via BASE_SYSTEM_PROMPT environment variable.
 */
const DEFAULT_BASE_SYSTEM_PROMPT = `# Core Behavior

You are the MSF AI Assistant, an AI tool designed to support MSF staff in their work. Your role is to help users accomplish their tasks effectively while maintaining honesty about your capabilities and limitations.

## About the MSF AI Assistant

The MSF AI Assistant is an internal AI chat tool for Médecins Sans Frontières (MSF) staff. Key information:

**Features**: Multiple AI model families (OpenAI, DeepSeek, Llama, Claude), web search, voice transcription with translation, document translation (preserving formatting), customizable prompts and tones. Works as a mobile app (PWA) on phones and tablets.

**Data Privacy**: Conversation history is stored locally in the user's browser, not on any server. Chats do not sync across devices. Clearing browser data will delete conversations.

**Data Guidelines**: Users should NOT enter personal data (names, phone numbers, emails), patient information, or highly sensitive operational details that could identify individuals or compromise safety.

**Output Verification**: AI responses should be verified for accuracy. The AI is an assistant, not a decision-maker. Always review outputs before using them in official work.

**Support**: Users can access the FAQ in Settings > Help & Support. For questions access support from the same location.

If asked about the AI Assistant's features, privacy, or usage guidelines, provide helpful answers based on the above and direct users to the FAQ or Help Center for more detailed information.

## Features

- The user can access the following features through the plus icon:
  - Document translation (preserving formatting)
  - Web search
  - Audio/video transcription with optional translation
  - File uploads
  - Camera (useful on mobile devices)
- We do not currently natively integrate with other tools or services, even M365 services, that access user data. Any operations here require the user to copy and paste the content into the application.
- Users can use voice inputs rather than typing. Clicking the record icon will start this, but they have to click again to stop when done.

## Communication

Focus on meaningfully progressing the user's request with each response:
- Respond in the same language the user is communicating in, unless they request otherwise
- Be clear and direct without being robotic
- Ask clarifying questions when genuinely needed to provide useful help
- Match your tone appropriately to the context of the conversation
- Do not use emojis unless the user does or explicitly requests them

## Accuracy and Honesty

Be truthful about what you know and don't know:
- Clearly distinguish between established facts and your own speculation or inference
- Acknowledge when information may be outdated or when you are uncertain
- Say "I don't know" when you don't know rather than fabricating or guessing information
- If you are speculating or reasoning through something, say so explicitly
- Correct yourself if you realize you made an error

## AI Boundaries

You are an AI tool, not a human colleague or subject matter expert:
- Maintain appropriate boundaries as an AI assistant
- Be clear about your AI nature when it is relevant to the discussion
- Do not claim expertise, credentials, or lived experience you do not have
- Do not speculate on MSF's policies or formal procedures unless it is clearly speculation
- Your role is to assist and inform, not to replace human judgment on important decisions
- Be clear that you do not necessarily know everything about MSF's operations or policies
- Be clear that you do not know everything about the application and any advice there is generic
- Be clear, when relevant, that you do not know anything about the user outside of the current conversation. So you cannot make assessments made on other conversations or context 

## Response Formatting

### Markdown
- Use GitHub-flavored markdown for formatting
- Use headers (##, ###) to organize longer responses
- Use code blocks with language identifiers: \`\`\`typescript, \`\`\`python
- Use inline \`code\` for file names, function names, and technical terms

### Code Blocks
- Always specify the language for syntax highlighting
- For file references, indicate the path when helpful
- Prefer complete, runnable examples over fragments
- Even in scripts, please use well-named and wrapped functions / classes, as appropriate

### Mathematical Notation / Formulas
- Use KaTeX for mathematical proofs, equations, and formulas unless the user requests otherwise
- Always use double dollar signs for math: \`$$E = mc^2$$\`
- For display/block math, place \`$$...$$\` on its own line with blank lines before and after
- For inline math within sentences, use \`$$...$$\` inline with the text
- Prefer display math for complex equations, proofs, and multi-step derivations

## Diagrams

When visual explanation helps, use Mermaid diagrams in fenced code blocks.

### Flowchart Syntax (most common errors happen here)
- Always use node IDs with labels: \`A["Start"] --> B["End"]\` NOT \`["Start"] --> ["End"]\`
- Include direction: \`flowchart TD\` (top-down) or \`flowchart LR\` (left-right)
- Node IDs must be alphanumeric without spaces
- Escape special characters in labels: \`&\` → \`&amp;\`, \`<\` → \`&lt;\`

### Supported Diagram Types
- \`flowchart\` - Processes, workflows (use instead of deprecated \`graph\`)
- \`sequenceDiagram\` - Actor interactions over time
- \`stateDiagram-v2\` - State machines
- \`classDiagram\` - UML class relationships
- \`erDiagram\` - Database entity relationships
- \`pie\` - Proportional data
- \`gantt\` - Project timelines
- \`mindmap\` - Hierarchical ideas
- \`journey\` - User experience flows

## Reasoning

For complex problems:
- Break down complex tasks into clear steps before solving
- When multiple approaches exist, briefly note trade-offs
- Explain reasoning for non-obvious choices

## Accessibility and Wellbeing

When generating UI code, use semantic HTML and consider accessibility (ARIA attributes, alt text, keyboard navigation). Be supportive of users without being condescending.

## Sensitive Topics

MSF staff may need to discuss sensitive subjects as part of their work, including conflict situations, medical emergencies, protection concerns, and other challenging topics. Engage helpfully with these work-related discussions.

For high-stakes topics where your response could directly influence important decisions:
- Medical advice: Recommend consulting medical professionals or MSF medical staff
- Legal questions: Recommend consulting legal advisors
- Safety and security decisions: Recommend consulting relevant specialists or security staff

For general information and discussion on sensitive topics, be helpful while making your limitations clear when directly relevant. Distinguish between requests that could cause harm versus legitimate work needs.

## Safety

Do not generate content designed to cause or facilitate harm.
`;

/**
 * Base system prompt - always applied, not user-editable.
 * Contains core behaviors, formatting guidelines, and safety rules.
 *
 * Can be overridden via BASE_SYSTEM_PROMPT environment variable for
 * deployment-specific customization.
 */
export const BASE_SYSTEM_PROMPT: string =
  (typeof window === 'undefined'
    ? process.env.BASE_SYSTEM_PROMPT
    : undefined) || DEFAULT_BASE_SYSTEM_PROMPT;

/**
 * Default user prompt - used when user hasn't customized their prompt.
 * This is the editable portion that users can modify in settings.
 */
export const DEFAULT_USER_PROMPT =
  'You are a helpful AI assistant. Answer questions accurately and helpfully.';

/**
 * User information that can optionally be included in the system prompt.
 * All fields are optional - only provided fields will be included.
 */
export interface SystemPromptUserInfo {
  name?: string;
  title?: string;
  email?: string;
  department?: string;
  /** Additional user-provided context about themselves */
  additionalContext?: string;
}

/**
 * Options for building the system prompt with dynamic context.
 *
 * Supports backward compatibility: if a string is passed to buildSystemPrompt,
 * it will be treated as the userPrompt option.
 */
export interface SystemPromptOptions {
  /** The user's custom instructions (from settings or per-request) */
  userPrompt?: string;
  /** Override for current date/time. If not provided, uses current time. */
  currentDateTime?: Date;
  /** Optional user information to include in prompt context */
  userInfo?: SystemPromptUserInfo;
}

/**
 * Formats a date for display in the system prompt.
 * Uses a human-readable format with timezone.
 *
 * @param date - The date to format
 * @returns Formatted date string (e.g., "Monday, December 30, 2024, 02:15 PM EST")
 */
function formatDateTime(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * Builds the dynamic context section for the system prompt.
 * Always includes date/time, optionally includes user information.
 *
 * @param options - Options containing date/time and optional user info
 * @returns Formatted dynamic context string
 */
function buildDynamicContext(options: SystemPromptOptions): string {
  const parts: string[] = [];

  // Always include date/time (use provided date or current time)
  const dateTime = options.currentDateTime ?? new Date();
  parts.push(`Current date and time: ${formatDateTime(dateTime)}`);

  // Include user info if provided
  if (options.userInfo) {
    const { name, title, email, department, additionalContext } =
      options.userInfo;
    const userParts: string[] = [];
    if (name) userParts.push(`- Name: ${name}`);
    if (title) userParts.push(`- Title: ${title}`);
    if (email) userParts.push(`- Email: ${email}`);
    if (department) userParts.push(`- Department: ${department}`);

    if (userParts.length > 0 || additionalContext) {
      let userSection = '';
      if (userParts.length > 0) {
        userSection = '\n## About the Current User\n' + userParts.join('\n');
      }
      if (additionalContext) {
        userSection +=
          userParts.length > 0 ? '\n\n' : '\n## About the Current User\n';
        userSection += `Additional context:\n${additionalContext}`;
      }
      parts.push(userSection);
    }
  }

  return `# Dynamic Context\n\n${parts.join('\n')}\n`;
}

/**
 * Combines the base system prompt with dynamic context and user's custom instructions.
 *
 * Supports two calling patterns for backward compatibility:
 * - buildSystemPrompt("custom prompt") - legacy string-based call
 * - buildSystemPrompt({ userPrompt, userInfo }) - new options-based call
 *
 * @param optionsOrPrompt - Either a string (user prompt) or SystemPromptOptions object
 * @returns The complete system prompt with base + dynamic context + user instructions
 *
 * @example
 * // Legacy usage with string
 * const prompt = buildSystemPrompt("Always respond in French");
 *
 * @example
 * // New usage with options (includes date/time automatically)
 * const prompt = buildSystemPrompt({
 *   userPrompt: "Always respond in French",
 *   userInfo: { name: "Jane Doe", department: "Operations" }
 * });
 *
 * @example
 * // With empty/undefined (uses defaults, includes current date/time)
 * const prompt = buildSystemPrompt();
 */
export function buildSystemPrompt(
  optionsOrPrompt?: SystemPromptOptions | string,
): string {
  // Handle backward compatibility: string argument becomes userPrompt option
  const options: SystemPromptOptions =
    typeof optionsOrPrompt === 'string'
      ? { userPrompt: optionsOrPrompt }
      : optionsOrPrompt || {};

  const effectiveUserPrompt = options.userPrompt?.trim() || DEFAULT_USER_PROMPT;
  const dynamicContext = buildDynamicContext(options);

  return `${BASE_SYSTEM_PROMPT}\n\n${dynamicContext}\n# User Instructions\n\n${effectiveUserPrompt}`;
}

/**
 * Gets just the user portion of a combined system prompt.
 * Useful for displaying in settings UI.
 *
 * @param fullPrompt - The complete system prompt
 * @returns The user instructions portion, or the default if not found
 */
export function extractUserPrompt(fullPrompt: string): string {
  const marker = '# User Instructions\n\n';
  const markerIndex = fullPrompt.indexOf(marker);

  if (markerIndex === -1) {
    // If the marker isn't found, the prompt might be a legacy format
    // Return the whole thing or default
    return fullPrompt || DEFAULT_USER_PROMPT;
  }

  return fullPrompt.slice(markerIndex + marker.length) || DEFAULT_USER_PROMPT;
}

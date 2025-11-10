# Chat Pipeline Flow Visualization

## Complete Request-to-Response Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     HTTP POST /api/chat                         │
│  Request Body: { model, messages, botId?, searchMode?, ... }   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────┐
        │  buildChatContext() Function   │
        │  (Middleware Chain)            │
        └────────────────────┬───────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
    ┌─────────┐        ┌──────────┐       ┌──────────┐
    │   Auth  │        │ Logging  │       │ Request  │
    │Middleware       │Middleware│       │Parsing   │
    └─────────┘        └──────────┘       │Middleware│
         │                   │            └────┬─────┘
         └───────────────────┼─────────────────┘
                             │
                             ▼
            ┌─────────────────────────────┐
            │ Content Analysis Middleware │
            │ (Detect files/images/audio) │
            └──────────────┬──────────────┘
                           │
                           ▼
            ┌─────────────────────────────┐
            │ Model Selection Middleware  │
            │ (Validate & auto-upgrade)   │
            └──────────────┬──────────────┘
                           │
                           ▼
        ┌──────────────────────────────────┐
        │    ChatContext Fully Built       │
        │  (Single Source of Truth)        │
        └──────────────┬───────────────────┘
                       │
                       ▼
    ╔════════════════════════════════════════════════╗
    ║          PIPELINE STAGE EXECUTION              ║
    ║  (Stages run sequentially in order below)      ║
    ╚════════════════════┬═════════════════════════╝
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
   ┌──────────┐  ┌──────────┐  ┌──────────────┐
   │  File    │  │ Image    │  │ (Conditional)│
   │Processor │  │Processor │  │   Stages:    │
   │          │  │          │  │  - RAG       │
   │shouldRun:│  │shouldRun:│  │  - Tool      │
   │hasFiles? │  │hasImages?│  │    Router    │
   └────┬─────┘  └────┬─────┘  │  - Agent     │
        │             │        │             │
        │             │        └──────┬──────┘
        │             │               │
        └─────────────┼───────────────┘
                      │
                      ▼
    ┌────────────────────────────────────┐
    │   Feature Enrichers (if enabled)   │
    │  (Add capabilities to messages)     │
    └────────┬──────────────┬────────────┘
             │              │
        ┌────▼──┐      ┌────▼────┐
        │  RAG  │      │ Tool    │
        │Enricher      │Router   │
        │        │      │Enricher │
        │If botId       │If search│
        │present        │Mode set │
        └────┬──┘      └────┬────┘
             │              │
             └──────┬───────┘
                    │
                    ▼
    ┌────────────────────────────────────┐
    │  Agent Enricher (if agentMode)     │
    │  (Determines execution strategy)    │
    └────────┬───────────────────────────┘
             │
             ├─ If agent supported:
             │  Set executionStrategy = 'agent'
             │
             └─ If files/images present:
                Set executionStrategy = 'standard'
                (agents don't support files yet)
                    │
                    ▼
    ┌────────────────────────────────────┐
    │    Execution Handler Selection     │
    └─────┬──────────────┬───────────────┘
          │              │
      ┌───▼──┐      ┌────▼────────┐
      │Agent │      │Standard Chat │
      │Chat  │      │Handler       │
      │Handler       │              │
      │       │      │ (Falls back) │
      │If     │      │              │
      │agent  │      │Always runs   │
      │       │      │unless agent  │
      └───┬──┘      └────┬─────────┘
          │              │
          └──────┬───────┘
                 │
          ┌──────▼────────┐
          │ Execution     │
          ├────────────────┤
          │ 1. Call service│
          │ 2. Stream or   │
          │    JSON response
          │ 3. Handle      │
          │    errors      │
          │ 4. Return      │
          │    Response    │
          └──────┬────────┘
                 │
                 ▼
    ┌────────────────────────────────────┐
    │   Pipeline Complete - Context      │
    │   Updated with Response            │
    └────────┬───────────────────────────┘
             │
             ▼
    ┌────────────────────────────────────┐
    │  Check for Errors                  │
    │  If errors & no response: 500       │
    │  If response: return it             │
    └────────┬───────────────────────────┘
             │
             ▼
    ╔════════════════════════════════════╗
    ║   HTTP Response Sent to Client     ║
    ║   - Streaming: text/event-stream   ║
    ║   - JSON: application/json         ║
    ║   - Error: 500 with details        ║
    ╚════════════════════════════════════╝
```

---

## Pipeline Stages - Details

### 1. FileProcessor

```
Condition: context.hasFiles = true

Input:  Message with file_url content
        └─ type: 'file_url'
           url: 'blob://...'

Processing:
  1. Download file from Azure Blob Storage
  2. Detect file type (PDF, DOCX, MP3, MP4, etc.)
  3. Extract content based on type
     - Documents → text extraction
     - Audio/Video → transcription queue
     - Code files → syntax highlighting
  4. Summarize document using LLM (parseAndQueryFileOpenAI)
  5. Return transcript and/or summary

Output: context.processedContent = {
  fileSummaries: [{
    filename: string
    summary: string        // LLM-generated summary
    originalContent: string
  }],
  transcripts: [{
    filename: string
    transcript: string     // Whisper result or processing
  }],
  images: [...]           // If images detected
}
```

### 2. ImageProcessor

```
Condition: context.hasImages = true

Input:  Message with image_url content
        └─ type: 'image_url'
           image_url: { url: string, detail: 'auto'|'low'|'high' }

Processing:
  1. Validate image URL is accessible
  2. Determine appropriate detail level
     - 'auto': Let model decide
     - 'low': Faster, lower tokens
     - 'high': Full detail, more tokens
  3. Pass through to chat model

Output: context.processedContent.images = [{
  url: string
  detail: 'auto' | 'low' | 'high'
}]
```

### 3. RAGEnricher

```
Condition: context.botId is set

Input:  Processed context (may have file summaries/transcripts)
        botId: string (knowledge base ID)

Processing:
  1. Extract query from last message or use entire context
  2. Query Azure AI Search with botId-specific index
  3. Execute semantic search for relevant documents
  4. Rank results by relevance score
  5. Format results as RAG context
  6. Add to system message or messages array

Output: context.enrichedMessages = [
  ... original messages ...
  {
    role: 'system'|'user',
    content: "RAG Context:\n[Document 1]\n[Document 2]\n..."
  }
]
```

### 4. ToolRouterEnricher

```
Condition: context.searchMode = 'INTELLIGENT' | 'ALWAYS'

Input:  Last message content (possibly with file/image context)
        searchMode: SearchMode

Processing (INTELLIGENT):
  1. Send message to GPT-5-mini (router model)
  2. Ask: "Does this query need web search?"
  3. Model analyzes query type
  4. If needs search → execute WebSearchTool
  5. Add search results to context

Processing (ALWAYS):
  1. Always execute WebSearchTool
  2. No AI decision needed

Output: context.enrichedMessages = [
  ... previous messages ...
  {
    role: 'user'|'assistant',
    content: "Web Search Results:\n[Result 1]\n[Result 2]\n..."
  }
]
```

### 5. AgentEnricher

```
Condition: context.agentMode = true AND model.agentId exists

Input:  Model with agentId configuration
        agentMode: boolean flag

Processing:
  1. Validate model has agentId
  2. Check if files or images present
     - If YES: Not yet supported, fall back to INTELLIGENT search
     - If NO: Proceed with agent
  3. Set executionStrategy = 'agent'

Output: context.executionStrategy = 'agent'
        (or fall back to INTELLIGENT search mode)
```

### 6. AgentChatHandler

```
Condition: context.executionStrategy = 'agent'

Input:  Full context with agentId set
        Messages potentially enriched by enrichers

Processing:
  1. Create Azure AI Foundry agent
  2. Set up conversation thread if threadId provided
  3. Send message to agent
  4. Agent executes tools (web search, etc.) as needed
  5. Collect agent response

Output: context.response = Response object
        (stops here - StandardChatHandler won't run)
```

### 7. StandardChatHandler (Always Runs - Unless Agent)

```
Condition: context.executionStrategy !== 'agent'

Input:  Final enrichedMessages or original messages + processedContent
        All enrichments applied from previous stages

Processing:
  1. Build final message array
     Priority:
     1. enrichedMessages (if from enrichers)
     2. processed + original (if processed content)
     3. original (if nothing else)
  2. Merge file summaries/transcripts into message text
  3. Keep images as separate content blocks
  4. Call StandardChatService
     - Select model handler (Azure/DeepSeek/Standard)
     - Apply tone to system prompt
     - Prepare messages with token limits
     - Execute appropriate handler
     - Stream or JSON response
  5. Return Response

Output: context.response = Response object
        (Streaming or JSON with text)
```

---

## Conditional Stage Execution

### FileProcessor

```
shouldRun() {
  return context.hasFiles;
}
```

### ImageProcessor

```
shouldRun() {
  return context.hasImages;
}
```

### RAGEnricher

```
shouldRun() {
  return !!context.botId;  // Only if RAG bot ID provided
}
```

### ToolRouterEnricher

```
shouldRun() {
  return context.searchMode === SearchMode.INTELLIGENT ||
         context.searchMode === SearchMode.ALWAYS;
}
```

### AgentEnricher

```
shouldRun() {
  return !!context.agentMode && !!context.model.agentId;
}
```

### AgentChatHandler

```
shouldRun() {
  return context.executionStrategy === 'agent';
}
```

### StandardChatHandler

```
shouldRun() {
  return context.executionStrategy !== 'agent';
}
```

---

## Message Flow Through Enrichers

```
Original Message:
  role: 'user'
  content: [
    { type: 'text', text: 'Analyze file and search...' },
    { type: 'file_url', url: 'blob://...' }
  ]

                    ▼

After FileProcessor:
  processedContent = {
    fileSummaries: [{ filename, summary, originalContent }],
    transcripts: [...]
  }
  (messages unchanged)

                    ▼

After RAGEnricher (if botId):
  enrichedMessages = [
    ... original messages ...
    {
      role: 'system',
      content: 'RAG Context: [doc1] [doc2]...'
    }
  ]

                    ▼

After ToolRouterEnricher (if searchMode):
  enrichedMessages = [
    ... previous enriched messages ...
    {
      role: 'user',
      content: 'Web Search Results: [result1] [result2]...'
    }
  ]

                    ▼

Final Message Building (StandardChatHandler):
  finalMessages = [
    ... all enriched messages ...
    {
      role: 'user',
      content: 'Original text\n\n[FILE SUMMARY]\n\n[WEB RESULTS]...'
    }
  ]
```

---

## Error Handling Flow

```
During Stage Execution:

try {
  result = await stage.execute(context)

  // Check for critical errors that stop pipeline
  if (result.errors?.some(e => e.includes('CRITICAL'))) {
    break;  // Stop pipeline
  }

} catch (error) {
  // Unexpected errors are caught and added
  result.errors = [... errors ..., error];
  continue;  // Continue to next stage
}

                    ▼

After Pipeline:

if (context.errors.length > 0) {
  log errors for analytics
}

if (!context.response) {
  if (context.errors.length > 0) {
    return 500 error with details
  }
  return 500 "Pipeline did not generate response"
}

return context.response
```

---

## Performance Metrics Collection

```
Pipeline Start
  │
  ├─ Stage 1 Start → Stage 1 End
  │   Duration: X ms
  │   Recorded in: context.metrics.stageTimings
  │
  ├─ Stage 2 Start → Stage 2 End
  │   Duration: Y ms
  │
  ├─ Stage 3 (skipped)
  │   No timing
  │
  └─ Stage 4 Start → Stage 4 End
      Duration: Z ms

Pipeline Complete
  Total time: startTime to endTime
  All timings: { Stage1: X, Stage2: Y, Stage4: Z }
  Logged to Azure Monitor
```

---

## Common Flow Examples

### Example 1: Simple Text Chat

```
Request: { model, messages: [{ role: 'user', content: 'Hello' }] }

Pipeline:
  FileProcessor     → skip (no files)
  ImageProcessor    → skip (no images)
  RAGEnricher       → skip (no botId)
  ToolRouterEnricher→ skip (no searchMode)
  AgentEnricher     → skip (no agentMode)
  StandardChatHandler → EXECUTE
                       → Return LLM response
```

### Example 2: File Analysis with RAG

```
Request: { model, messages: [file_url, text], botId: 'X' }

Pipeline:
  FileProcessor     → EXECUTE
                      → Download, extract, summarize file
  ImageProcessor    → skip (no images)
  RAGEnricher       → EXECUTE
                      → Query knowledge base with summary
  ToolRouterEnricher→ skip (no searchMode)
  AgentEnricher     → skip
  StandardChatHandler → EXECUTE
                       → Merge file summary + RAG context
                       → Return response
```

### Example 3: Agent Mode

```
Request: { model: {agentId: 'X'}, messages, agentMode: true }

Pipeline:
  FileProcessor     → skip (if no files) or EXECUTE (if files)
  ImageProcessor    → skip (if no images) or EXECUTE (if images)
  RAGEnricher       → skip (no botId)
  ToolRouterEnricher→ skip (no searchMode)
  AgentEnricher     → EXECUTE
                      → Set executionStrategy = 'agent'
  AgentChatHandler  → EXECUTE
                      → Call AI Foundry agent
                      → Return agent response
  StandardChatHandler → skip (agent mode)
```

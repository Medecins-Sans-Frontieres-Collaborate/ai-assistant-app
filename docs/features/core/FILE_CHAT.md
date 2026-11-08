# File-Based Chat Workflow

This document provides comprehensive documentation of the file-based chat workflow, covering images, audio/video, documents, and all supported formats from end to end.

## Table of Contents

1. [Overview](#overview)
2. [Client-Side Flow](#client-side-flow)
3. [Server-Side Flow](#server-side-flow)
4. [Supported File Types](#supported-file-types)
5. [Key Components Reference](#key-components-reference)
6. [Data Flow Diagrams](#data-flow-diagrams)
7. [Troubleshooting](#troubleshooting)

---

## Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT SIDE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. User selects file(s)                                                     │
│         │                                                                    │
│         ▼                                                                    │
│  2. onFileUpload() in chatInputStore                                         │
│         │                                                                    │
│         ▼                                                                    │
│  3. FileUploadService.uploadMultipleFiles()                                  │
│         │                                                                    │
│         ▼                                                                    │
│  4. POST /api/file/upload → Azure Blob Storage                               │
│         │                                                                    │
│         ▼                                                                    │
│  5. Returns URL: /api/file/{hash}.{ext}                                      │
│         │                                                                    │
│         ▼                                                                    │
│  6. Stored in chatInputStore.fileFieldValue as FileMessageContent            │
│         │                                                                    │
│         ▼                                                                    │
│  7. User clicks Send → useMessageSender.handleSend()                         │
│         │                                                                    │
│         ▼                                                                    │
│  8. buildMessageContent() creates Message with file_url content              │
│         │                                                                    │
│         ▼                                                                    │
│  9. conversationStore.addMessage() → chatService.chat()                      │
│         │                                                                    │
│         ▼                                                                    │
│  10. Client Transformations:                                                 │
│      - convertImagesToBase64() - Image URLs → base64 data URLs               │
│      - convertDocumentTranslationUrlsToPlaceholders() -                      │
│        /api/document-translation/* → text placeholders                       │
│         │                                                                    │
│         ▼                                                                    │
│  11. POST /api/chat with transformed messages                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVER SIDE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. POST /api/chat → buildChatContext()                                      │
│         │                                                                    │
│         ▼                                                                    │
│  2. Middleware Chain:                                                        │
│     a. authMiddleware - Session validation                                   │
│     b. requestParsingMiddleware → InputValidator.validateChatRequest()       │
│     c. createContentAnalysisMiddleware - Detects file/image/audio            │
│     d. createModelSelectionMiddleware - Routes to appropriate model          │
│         │                                                                    │
│         ▼                                                                    │
│  3. Pipeline Stages:                                                         │
│     a. FileProcessor.executeStage() [CRITICAL: LAST MESSAGE ONLY]            │
│        - Extract file_url items from messages[messages.length - 1]           │
│        - Validate file sizes before download                                 │
│        - Download files from blob storage                                    │
│        - Process by type:                                                    │
│          • Audio/Video: Transcribe (Whisper ≤25MB, Chunked >25MB)            │
│          • Documents: Extract text + summarize via parseAndQueryFileOpenAI() │
│          • Images: Convert to base64                                         │
│        - Store results in context.processedContent                           │
│         │                                                                    │
│         ▼                                                                    │
│  4. Handler Chain (Chain of Responsibility):                                 │
│     ForcedAgentHandler → RAGHandler → AIFoundryAgentChatHandler              │
│     → ReasoningModelHandler → StandardModelChatHandler                       │
│         │                                                                    │
│         ▼                                                                    │
│  5. StandardChatHandler.buildFinalMessages():                                │
│     - Inject fileSummaries as text: "[File: filename]\n{summary}"            │
│     - Inject transcripts as text: "[Audio/Video: filename]\n{transcript}"    │
│     - Replace image URLs with base64                                         │
│     - STRIPS file_url content types (NOT sent to LLM)                        │
│         │                                                                    │
│         ▼                                                                    │
│  6. Stream response back to client                                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Client-Side Flow

### 1. File Selection & Upload

**Entry Point:** `client/handlers/chatInput/file-upload.ts`

```typescript
// onFileUpload() in chatInputStore triggers this flow
export async function handleFileUpload(
  files: FileList,
  existingFilePreviews: FilePreview[],
  // ... callbacks
): Promise<FileFieldValue>;
```

**Flow:**

1. User selects files via `<input type="file">` or drag-drop
2. `categorizeFile()` determines file type (image, audio, video, document)
3. Validation against PER-MESSAGE limits in `client/handlers/chatInput/attachmentLimits.ts`
   (files already in the composer count, so attaching in several selections cannot exceed them):
   - Max 10 total files (raised to the documents limit when that is higher)
   - Max 10 images
   - Documents (anything not an image or audio/video): `feature.upload.documentsPerMessage`,
     default 5, admin-overridable per user/domain/group up to 20 (config/limits.ts). The chat
     route enforces the same limit server-side (createLimitsMiddleware).
   - Max 1 audio/video file
   - Max 1.5GB total per message
4. Size limits checked per category:
   - `IMAGE`: 5MB
   - `AUDIO`: 1GB
   - `VIDEO`: 1.5GB
   - `DOCUMENT`: 50MB
5. `FileUploadService.uploadMultipleFiles()` uploads to blob storage

**Result:** `FileMessageContent` objects stored in `chatInputStore.fileFieldValue`

```typescript
interface FileMessageContent {
  type: 'file_url';
  url: string; // e.g., "/api/file/abc123.pdf"
  originalFilename?: string;
  mimeType?: string;
  transcriptionLanguage?: string;
  transcriptionPrompt?: string;
}
```

### 2. Message Building

**Entry Point:** `client/hooks/chat/useMessageSender.ts`

```typescript
const handleSend = useCallback(async () => {
  // 1. Validate submission
  const validation = validateMessageSubmission(textFieldValue, filePreviews, uploadProgress);

  // 2. Merge transcription options from UI previews
  const fileFieldWithTranscriptionOptions = mergeTranscriptionOptions(fileFieldValue, filePreviews);

  // 3. Build message content
  const content = buildMessageContent(submitType, textFieldValue, imageFieldValue, filteredFileFieldValue, null);

  // 4. Send message
  onSend({
    role: 'user',
    content,
    messageType: mapSubmitTypeToMessageType(submitType),
    toneId: selectedToneId,
    // ...
  }, searchMode);
}, [...]);
```

**Content Builder:** `lib/utils/shared/chat/contentBuilder.ts`

Creates message content array combining text, images, and files:

```typescript
// Result format for file messages
[
  { type: 'text', text: 'User question about the file' },
  {
    type: 'file_url',
    url: '/api/file/abc123.pdf',
    originalFilename: 'report.pdf',
    mimeType: 'application/pdf',
  },
];
```

### 3. API Call & Transformations

**Entry Point:** `client/services/chat/ChatService.ts`

```typescript
public async chat(model, messages, options): Promise<ReadableStream<Uint8Array>> {
  // Transform 1: Images to base64 (for LLM vision)
  const messagesWithBase64Images = await convertImagesToBase64(messages);

  // Transform 2: Document translation URLs to placeholders
  // ONLY affects /api/document-translation/* URLs
  // Regular /api/file/* URLs pass through unchanged
  const messagesWithPlaceholders = convertDocumentTranslationUrlsToPlaceholders(messagesWithBase64Images);

  return apiClient.postStream('/api/chat', {
    model,
    messages: messagesWithPlaceholders,
    // ...options
  });
}
```

**Image Conversion:** `convertImagesToBase64()`

- Converts image URLs to base64 data URLs at API call time
- Keeps localStorage small (only stores URL references)
- Uses `fetchImageBase64FromMessageContent()` to fetch from blob storage

**Document Translation Placeholder:** `convertDocumentTranslationUrlsToPlaceholders()`

- ONLY converts `/api/document-translation/*` URLs to `[Document: filename]` text
- Regular `/api/file/*` URLs are preserved for server-side processing
- This is intentional: document translations are historical references that don't need reprocessing

---

## Server-Side Flow

### 1. Request Validation

**Entry Point:** `app/api/chat/route.ts` → `lib/services/chat/pipeline/Middleware.ts`

**InputValidator** (`lib/services/chat/validators/InputValidator.ts`):

```typescript
// URL validation accepts:
// 1. data: URLs (base64)
// 2. /api/* relative URLs (internal file references)
// 3. Absolute URLs (blob storage)
const urlOrDataUrl = (errorMessage: string) =>
  z.string().refine(
    (val) => {
      if (val.startsWith('data:')) return true;
      if (val.startsWith('/api/')) return true;
      try {
        new URL(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: errorMessage },
  );
```

**Domain Whitelist:** `isValidFileUrl()`

- `*.blob.core.windows.net` (Azure Blob Storage)
- `localhost` (development)

### 2. Content Analysis

**Middleware:** `createContentAnalysisMiddleware()` in `Middleware.ts`

Sets flags on `ChatContext`:

- `hasFiles`: true if any `file_url` content found
- `hasImages`: true if any `image_url` content found
- `hasAudioVideo`: true if audio/video MIME types detected

### 3. File Processing (CRITICAL)

**Processor:** `lib/services/chat/processors/FileProcessor.ts`

```typescript
public async executeStage(context: ChatContext): Promise<void> {
  // CRITICAL: Only processes the LAST message!
  const lastMessage = context.messages[context.messages.length - 1];

  // Extract file_url items
  const fileUrls = this.extractFileUrls(lastMessage);

  // Process each file
  for (const fileUrl of fileUrls) {
    // Validate size before download
    await this.inputValidator.validateFileSize(fileUrl.url, user, getFileSize);

    // Download from blob storage
    const fileBuffer = await this.fileService.downloadFile(fileUrl.url, user);

    // Process based on type
    if (isAudioVideo(fileUrl.mimeType)) {
      const transcript = await this.transcribe(fileBuffer, fileUrl);
      context.processedContent.transcripts.push({ filename, transcript });
    } else if (isDocument(fileUrl.mimeType)) {
      const summary = await this.parseAndSummarize(fileBuffer, fileUrl);
      context.processedContent.fileSummaries.push({ filename, summary });
    }
    // Images are handled separately via base64 conversion
  }
}
```

**Key Behavior:**

- Only the LAST message is processed for files
- Historical messages with file_url content are NOT reprocessed
- Files must be in `messages[messages.length - 1].content` array

### 4. File Processing Service

**Service:** `lib/services/chat/FileProcessingService.ts`

```typescript
async downloadFile(fileUrl: string, user: Session['user']): Promise<Buffer> {
  // Extract file ID from URL: /api/file/{id}.{ext} → {id}.{ext}
  const fileId = fileUrl.split('/').pop();

  // Download from Azure Blob Storage
  const blobClient = containerClient.getBlobClient(`uploads/${fileId}`);
  return await blobClient.downloadToBuffer();
}
```

### 5. Text Extraction

**Utilities:** `lib/utils/server/file/fileHandling.ts`

| File Type | Extraction Method      |
| --------- | ---------------------- |
| PDF       | `pdfjs-dist` library   |
| DOCX      | `Pandoc` CLI           |
| XLSX      | `ssconvert` (Gnumeric) |
| PPTX      | `LibreOffice` headless |
| TXT/MD    | Direct read            |
| CSV       | Direct read            |

### 6. Audio/Video Transcription

**Service:** `lib/services/transcription/`

| File Size | Method                                             |
| --------- | -------------------------------------------------- |
| ≤25MB     | Direct Whisper API call                            |
| >25MB     | Chunked transcription (split → transcribe → merge) |

### 7. Final Message Building

**Handler:** `lib/services/chat/handlers/StandardChatHandler.ts`

```typescript
private buildFinalMessages(context: ChatContext): OpenAIMessage[] {
  const messages = [...context.messages];

  // Inject file summaries
  for (const { filename, summary } of context.processedContent.fileSummaries) {
    messages.push({
      role: 'user',
      content: `[File: ${filename}]\n${summary}`
    });
  }

  // Inject transcripts
  for (const { filename, transcript } of context.processedContent.transcripts) {
    messages.push({
      role: 'user',
      content: `[Audio/Video: ${filename}]\n${transcript}`
    });
  }

  // Process images: replace URLs with base64
  // STRIP file_url content types (not sent to LLM)
  return messages.map(msg => this.processMessageContent(msg));
}
```

---

## Supported File Types

### Images

| Extension  | MIME Type  | Processing            |
| ---------- | ---------- | --------------------- |
| .jpg/.jpeg | image/jpeg | Base64 → Vision model |
| .png       | image/png  | Base64 → Vision model |
| .gif       | image/gif  | Base64 → Vision model |
| .webp      | image/webp | Base64 → Vision model |

### Audio

| Extension | MIME Type  | Processing            |
| --------- | ---------- | --------------------- |
| .mp3      | audio/mpeg | Whisper transcription |
| .wav      | audio/wav  | Whisper transcription |
| .m4a      | audio/m4a  | Whisper transcription |
| .ogg      | audio/ogg  | Whisper transcription |
| .flac     | audio/flac | Whisper transcription |

### Video

| Extension | MIME Type       | Processing                 |
| --------- | --------------- | -------------------------- |
| .mp4      | video/mp4       | Audio extraction → Whisper |
| .webm     | video/webm      | Audio extraction → Whisper |
| .mov      | video/quicktime | Audio extraction → Whisper |

### Documents

| Extension | MIME Type                                                                 | Processing             |
| --------- | ------------------------------------------------------------------------- | ---------------------- |
| .pdf      | application/pdf                                                           | pdfjs-dist extraction  |
| .docx     | application/vnd.openxmlformats-officedocument.wordprocessingml.document   | Pandoc extraction      |
| .xlsx     | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet         | ssconvert extraction   |
| .pptx     | application/vnd.openxmlformats-officedocument.presentationml.presentation | LibreOffice extraction |
| .txt      | text/plain                                                                | Direct read            |
| .md       | text/markdown                                                             | Direct read            |
| .csv      | text/csv                                                                  | Direct read            |

---

## Key Components Reference

### Client-Side

| File                                       | Purpose                                        |
| ------------------------------------------ | ---------------------------------------------- |
| `client/stores/chatInputStore.ts`          | State management for file uploads, previews    |
| `client/handlers/chatInput/file-upload.ts` | Upload handling, validation, video extraction  |
| `client/hooks/chat/useMessageSender.ts`    | Message building, transcription option merging |
| `client/services/chat/ChatService.ts`      | API calls, image/URL transformations           |
| `client/services/fileUploadService.ts`     | Blob storage upload service                    |
| `lib/utils/shared/chat/contentBuilder.ts`  | Message content array construction             |

### Server-Side

| File                                                | Purpose                                       |
| --------------------------------------------------- | --------------------------------------------- |
| `app/api/file/upload/route.ts`                      | Upload endpoint → Blob storage                |
| `app/api/file/[id]/route.ts`                        | File retrieval endpoint                       |
| `app/api/chat/route.ts`                             | Chat endpoint entry point                     |
| `lib/services/chat/pipeline/Middleware.ts`          | Request parsing, validation, content analysis |
| `lib/services/chat/validators/InputValidator.ts`    | Zod validation, URL validation, size checks   |
| `lib/services/chat/processors/FileProcessor.ts`     | Main file processing stage                    |
| `lib/services/chat/FileProcessingService.ts`        | Blob download, file operations                |
| `lib/services/chat/handlers/StandardChatHandler.ts` | Final message building, content injection     |
| `lib/utils/server/file/fileHandling.ts`             | Text extraction (PDF, DOCX, etc.)             |

### Configuration

| File                          | Purpose                              |
| ----------------------------- | ------------------------------------ |
| `lib/constants/fileTypes.ts`  | File type definitions, MIME mappings |
| `lib/constants/fileLimits.ts` | Size limits per category             |
| `lib/utils/app/const.ts`      | `VALIDATION_LIMITS` constants        |

---

## Data Flow Diagrams

### Upload Flow

```
┌──────────┐     ┌────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User    │────▶│ onFileUpload() │────▶│ uploadMultiple   │────▶│ POST /api/file/ │
│  selects │     │ chatInputStore │     │ Files()          │     │ upload          │
│  file    │     └────────────────┘     └──────────────────┘     └────────┬────────┘
└──────────┘                                                              │
                                                                          ▼
┌──────────────────┐     ┌────────────────────┐     ┌─────────────────────────────┐
│ FileMessageContent│◀────│ Return URL:        │◀────│ Azure Blob Storage          │
│ stored in store  │     │ /api/file/{hash}   │     │ uploads/{hash}.{ext}        │
└──────────────────┘     └────────────────────┘     └─────────────────────────────┘
```

### Send Flow

```
┌──────────────┐     ┌─────────────────┐     ┌────────────────────┐
│ User clicks  │────▶│ handleSend()    │────▶│ buildMessageContent│
│ Send         │     │ useMessageSender│     │ contentBuilder.ts  │
└──────────────┘     └─────────────────┘     └─────────┬──────────┘
                                                       │
                                                       ▼
┌────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│ chatService.chat() │◀────│ conversationStore    │◀────│ Message with        │
│ ChatService.ts     │     │ addMessage()         │     │ file_url content    │
└─────────┬──────────┘     └──────────────────────┘     └─────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Client Transformations:                                                      │
│ 1. convertImagesToBase64() - Fetch image from blob, convert to data: URL    │
│ 2. convertDocumentTranslationUrlsToPlaceholders() - ONLY /api/doc-trans/*   │
└─────────┬───────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────┐
│ POST /api/chat  │
│ with messages   │
└─────────────────┘
```

### Server Processing Flow

```
┌─────────────────┐
│ POST /api/chat  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Middleware Chain:                                                            │
│ authMiddleware → requestParsingMiddleware → contentAnalysisMiddleware       │
│                  (InputValidator)            (sets hasFiles, hasImages)      │
└────────┬────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ FileProcessor.executeStage()                                                 │
│                                                                              │
│ CRITICAL: Only processes messages[messages.length - 1] (LAST message)        │
│                                                                              │
│ For each file_url in last message:                                          │
│   1. Validate file size (before download)                                   │
│   2. Download from blob storage                                             │
│   3. Process by type:                                                       │
│      - Audio/Video → Transcribe                                             │
│      - Document → Extract text + Summarize                                  │
│   4. Store in context.processedContent                                      │
└────────┬────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ StandardChatHandler.buildFinalMessages()                                     │
│                                                                              │
│ 1. Inject fileSummaries: "[File: report.pdf]\n{extracted text summary}"     │
│ 2. Inject transcripts: "[Audio/Video: recording.mp3]\n{transcript}"          │
│ 3. Convert image URLs to base64                                             │
│ 4. STRIP file_url content types (not understood by LLM)                     │
└────────┬────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│ Call LLM with       │
│ processed messages  │
└─────────────────────┘
```

---

## Troubleshooting

### Common Issues

#### 1. "Invalid file URL" Validation Error

**Symptom:** `VALIDATION_FAILED: messages.0.content.0.url: Invalid file URL`

**Cause:** URL doesn't pass `urlOrDataUrl()` validation

**Check:**

- URL format should be one of:
  - `data:...` (base64)
  - `/api/file/...` or `/api/document-translation/...` (relative API URLs)
  - Absolute URL with valid host

**Debug:**

```typescript
// In InputValidator.ts, the validator accepts:
if (val.startsWith('data:')) return true;
if (val.startsWith('/api/')) return true;
new URL(val); // Must be valid absolute URL
```

#### 2. Files Not Being Processed

**Symptom:** File appears in message but content isn't extracted/summarized

**Root Cause:** FileProcessor only processes the LAST message

**Check:**

1. Is the file_url in `messages[messages.length - 1].content`?
2. Is `hasFiles` set to true in ChatContext?
3. Does `FileProcessor.shouldRun()` return true?

**Debug:**

```bash
# Look for these server logs:
[FileProcessor] Processing X file(s), Y image(s)
[FileProcessor] Downloading file: /api/file/...
[FileProcessor] File processed successfully: filename.pdf
```

#### 3. Document Translation URLs Causing Errors

**Symptom:** Chat fails after document translation with file URL validation errors

**Cause:** Historical document translation URLs in conversation history

**Solution:** These URLs are converted to text placeholders by `convertDocumentTranslationUrlsToPlaceholders()` in ChatService

**Note:** Only `/api/document-translation/*` URLs are converted. Regular `/api/file/*` URLs pass through for processing.

#### 4. Large File Download Timeout

**Symptom:** Request times out when processing large files

**Check:**

- File size validation happens BEFORE download
- Default max size: `VALIDATION_LIMITS.FILE_DOWNLOAD_MAX_BYTES`

**Debug:**

```bash
[InputValidator] File size validation passed: X.XXmb
[FileProcessingService] Downloading file: {id}
```

### Debugging Checklist

When file processing isn't working:

- [ ] **Client-side:** Is file_url in message content?

  ```javascript
  // Check in browser console
  console.log(JSON.stringify(message.content, null, 2));
  ```

- [ ] **Client-side:** Is URL being transformed incorrectly?

  ```javascript
  // Should see file_url with /api/file/* URL, NOT text placeholder
  // Unless it's /api/document-translation/* (those become placeholders)
  ```

- [ ] **Server-side:** Is file in LAST message?

  ```javascript
  // FileProcessor only processes: messages[messages.length - 1]
  ```

- [ ] **Server-side:** Is hasFiles flag set?

  ```javascript
  // Check contentAnalysisMiddleware logs
  [ContentAnalysis] hasFiles: true, hasImages: false, hasAudioVideo: false
  ```

- [ ] **Server-side:** Is FileProcessor running?

  ```javascript
  // Look for: [FileProcessor] Processing X file(s)
  // If not present, check shouldRun() conditions
  ```

- [ ] **Server-side:** Is file download succeeding?

  ```javascript
  // Look for: [FileProcessingService] Downloaded file: X bytes
  ```

- [ ] **Server-side:** Is extraction/summarization working?
  ```javascript
  // Look for: [FileProcessor] Extracted text: X chars
  // Or: [FileProcessor] Transcription complete: X words
  ```

### Server Log Patterns

**Successful file processing:**

```
[Middleware] Content analysis: hasFiles=true, hasImages=false
[FileProcessor] Processing 1 file(s), 0 image(s)
[FileProcessor] Downloading: /api/file/abc123.pdf
[FileProcessingService] Downloaded file: 1234567 bytes
[FileProcessor] Extracting text from PDF
[FileProcessor] Extracted text: 5432 chars
[FileProcessor] Summarizing with GPT
[FileProcessor] Summary generated: 500 chars
[StandardChatHandler] Injecting 1 file summary
```

**Failed file processing:**

```
[InputValidator] Rejected file URL from unauthorized host: evil.com
# OR
[FileProcessor] File size 150MB exceeds maximum 50MB
# OR
[FileProcessingService] Failed to download file: 404 Not Found
```

---

## Version History

| Date       | Change                |
| ---------- | --------------------- |
| 2024-12-30 | Initial documentation |

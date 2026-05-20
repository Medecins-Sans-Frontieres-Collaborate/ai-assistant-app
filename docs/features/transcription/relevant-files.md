### Relevant Files and Code for Transcription

#### Frontend Components

- `components/Chat/ChatInput/ChatInputVoiceCapture.tsx`: The main UI component for recording voice and triggering transcription.
- `client/hooks/transcription/useTranscriptionPolling.ts`: React hook that manages polling for asynchronous transcription jobs.
- `components/Chat/ChatInput/ChatInputTranscribe.tsx`: UI for transcribing already uploaded files.

#### API Routes

- `app/api/file/[id]/transcribe/route.ts`: Endpoint to initiate transcription for an uploaded file.
- `app/api/transcription/status/[jobId]/route.ts`: Endpoint to poll for the status and result of an async job.

#### Backend Services

- `lib/services/transcriptionService.ts`: Factory for creating transcription services.
- `lib/services/transcription/whisperTranscriptionService.ts`: Handles synchronous transcription using Azure OpenAI / Whisper.
- `lib/services/transcription/chunkedTranscriptionService.ts`: Logic for splitting large files and processing them in parallel.
- `lib/services/transcription/batchTranscriptionService.ts`: Legacy service for Azure Speech Batch API.
- `lib/services/transcription/chunkedJobStore.ts`: In-memory store for tracking chunked transcription jobs.
- `lib/services/chat/processors/FileProcessor.ts`: Pipeline stage that identifies and routes audio/video files for transcription.

#### Utilities

- `lib/utils/server/audio/audioExtractor.ts`: Uses FFmpeg to extract audio from video containers.
- `lib/utils/server/audio/audioSplitter.ts`: Uses FFmpeg to split audio files into chunks.
- `lib/services/transcription/common.ts`: Shared helpers for transcription services.

#### Types

- `types/transcription.ts`: Interface definitions for services, jobs, and API responses.

### Transcription Configuration

The transcription feature requires several environment variables to be set for the various services (Whisper and Azure Batch) and utilities (FFmpeg).

#### 1. Core Service Configuration

These variables are required for the standard Whisper-based transcription (used for both small files and chunked large files).

| Variable                | Description                                  | Default              |
| :---------------------- | :------------------------------------------- | :------------------- |
| `AZURE_OPENAI_ENDPOINT` | The endpoint for your Azure OpenAI resource. | -                    |
| `OPENAI_API_KEY`        | Your Azure OpenAI API key.                   | -                    |
| `OPENAI_API_VERSION`    | The API version to use.                      | `2025-04-01-preview` |

Note: The system looks for a deployment named `whisper` on your Azure OpenAI resource.

#### 2. Batch Transcription Configuration (Legacy)

Used by the Azure Speech batch API (large files) and fast transcription (the "Azure Speech" engine). Both authenticate as the application identity (Entra ID), which needs the **Cognitive Services Speech User** role on the account. Whisper uses the same identity and needs **Cognitive Services OpenAI User**.

| Variable                | Description                                                                                                        | Default                 |
| :---------------------- | :----------------------------------------------------------------------------------------------------------------- | :---------------------- |
| `AZURE_SPEECH_ENDPOINT` | Speech account custom-domain endpoint (`https://<name>.cognitiveservices.azure.com`). Regional hosts are rejected. | `AZURE_OPENAI_ENDPOINT` |

#### 3. FFmpeg Configuration

FFmpeg is essential for video-to-audio extraction and for splitting large audio files into chunks.

- **Installation**: FFmpeg must be installed on the server hosting the application.
- **Environment Variable**: The system expects the FFmpeg and FFprobe binaries to be in the system PATH, or you can specify the path using the `FFMPEG_BIN` environment variable (if supported by the underlying library).

#### 4. File Size Limits

The application defines size limits that determine which transcription path is taken:

- **Whisper Limit**: 25MB (defined in `lib/utils/app/const.ts` as `WHISPER_MAX_SIZE`).
- **Chunk Size**: 20MB (the target size when splitting large files in `ChunkedTranscriptionService.ts`).
- **Batch Limit**: Supports files up to 1GB.

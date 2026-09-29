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

#### 2. Speaker-Separated Transcription

Speaker separation uses the Azure AI Speech Fast Transcription API for files
within the Whisper size limit. It uses `AZURE_SPEECH_KEY` when set; otherwise,
it authenticates with `DefaultAzureCredential`, like the other Azure services.
It uses `AZURE_SPEECH_REGION` for the resource region. The app identity needs
the **Cognitive Services Speech User** role on each Speech resource it uses.
Regional routing follows the user's resolved region, the same way blob storage
does. Set `AZURE_SPEECH_KEY_EU` and `AZURE_SPEECH_REGION_EU` for EU users; if
they are unset, EU requests fall back to `AZURE_SPEECH_KEY` and
`AZURE_SPEECH_REGION`. Non-EU users use the base variables.

#### 3. Batch Transcription Configuration (Legacy)

Required only if using the Azure Speech Batch API for large files.

| Variable              | Description                           | Default  |
| :-------------------- | :------------------------------------ | :------- |
| `AZURE_SPEECH_KEY`    | API key for Azure Speech Services.    | -        |
| `AZURE_SPEECH_REGION` | Azure region for the Speech resource. | `eastus` |

#### 4. FFmpeg Configuration

FFmpeg is essential for video-to-audio extraction and for splitting large audio files into chunks.

- **Installation**: FFmpeg must be installed on the server hosting the application.
- **Environment Variable**: The system expects the FFmpeg and FFprobe binaries to be in the system PATH, or you can specify the path using the `FFMPEG_BIN` environment variable (if supported by the underlying library).

#### 5. File Size Limits

The application defines size limits that determine which transcription path is taken:

- **Whisper Limit**: 25MB (defined in `lib/utils/app/const.ts` as `WHISPER_MAX_SIZE`).
- **Chunk Size**: 20MB (the target size when splitting large files in `ChunkedTranscriptionService.ts`).
- **Batch Limit**: Supports files up to 1GB.

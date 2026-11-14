### TTS Architecture & Workflow

This document describes the technical implementation and flow of data for the Text-to-Speech feature.

### 1. Client-Side Trigger

TTS is triggered from two main areas in the application:

#### A. Chat Messages (`AssistantMessage`)

- The user clicks the speaker icon.
- A request is prepared with the current message content (or currently displayed translation).
- If the user right-clicks the speaker icon, a `TTSContextMenu` appears allowing for quick parameter overrides (voice, rate, pitch).

#### B. Transcript Viewer (`TranscriptViewer`)

- Used for audio/video file transcripts.
- The user clicks the speaker icon to synthesize the currently viewed transcript (original or translated).
- Uses global TTS settings; does not currently support quick overrides via context menu.

### 2. API Request

The client makes a POST request to `/api/chat/tts` with the following data:

- `text`: The raw text to speak.
- `voiceName` (optional): Explicit voice override.
- `rate` / `pitch` (optional): Overrides for speech speed and tone.
- `languageVoices`: The user's saved preferences for specific languages.
- `globalVoice`: The user's default global voice.

### 3. Server-Side Processing (`app/api/chat/tts/route.ts`)

The server performs several steps:

#### Text Sanitization

The raw text is processed through `cleanMarkdown` to remove:

- Bold/Italic markers.
- Code block delimiters.
- Other non-spoken markdown syntax.

#### Voice Resolution Logic

The server determines the `effectiveVoiceName` using a priority hierarchy:

1. **Explicit Override**: If `voiceName` is provided in the request body, use it.
2. **Multilingual Global**: If the user's `globalVoice` is a "Multilingual" type, use it directly (skipping language detection).
3. **Language-Specific**:
   - Detect the language of the text (using `detectLanguage` service).
   - Check if the user has a preferred voice for that language in `languageVoices`.
   - If found, use it.
4. **System Default**: Fall back to the system default voice for the detected language or the global system default (`en-US-AvaMultilingualNeural`).

#### Azure Authentication

The server authenticates as the application identity (Entra ID, `DefaultAzureCredential`) with `SpeechConfig.fromEndpoint(endpoint, credential)`, which acquires and refreshes tokens itself. The endpoint is the account custom domain from `AZURE_SPEECH_ENDPOINT`, or `AZURE_OPENAI_ENDPOINT` when unset (see `lib/utils/server/azure/cognitiveServicesAuth.ts`). There is no key path.

### 4. Speech Synthesis

The server uses the `microsoft-cognitiveservices-speech-sdk`.

- **SSML Generation**: If `rate` is not 1.0 or `pitch` is not 0, the server builds an **SSML (Speech Synthesis Markup Language)** string to apply these prosody settings.
- **Direct Synthesis**: If settings are default, it uses `speakTextAsync` for efficiency.
- **Output Format**: Configured via `speechSynthesisOutputFormat` (defaults to 24kHz 48kbps MP3).

### 5. Audio Streaming

The resulting audio buffer is pushed into a `Readable` stream and sent back to the client with `Content-Type: audio/mpeg`.

### 6. Client-Side Playback

- The client receives the blob.
- It creates a temporary URL using `URL.createObjectURL(blob)`.
- It plays the audio using a standard `Audio` object.
- The URL is revoked after playback or when the message is closed to prevent memory leaks.

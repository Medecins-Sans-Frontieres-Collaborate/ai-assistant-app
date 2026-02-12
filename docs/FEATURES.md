# Features

## Chat Interface

### Conversations

- **Create** - Start new conversations with customizable settings
- **Edit** - Rename and modify conversation metadata
- **Delete** - Remove conversations with confirmation
- **Search** - Full-text search across all conversations
- **Organize** - Folder-based organization system
- **Export/Import** - Backup and restore conversation history

### Message Handling

- **Streaming Responses** - Real-time AI responses with smooth streaming mode
- **Regenerate** - Re-run the last message with different results
- **Edit & Resubmit** - Modify previous messages and continue the conversation
- **Copy** - One-click copy of messages to clipboard
- **Code Blocks** - Syntax highlighting for code snippets
- **Markdown Support** - Rich text formatting in messages

### Customization

- **Temperature Control** - Adjust creativity vs. determinism (0.0 - 2.0)
- **System Prompts** - Set custom instructions for the AI
- **Model Selection** - Choose from available GPT models
- **Streaming Settings** - Configure smooth streaming speed and delay

## Advanced Features

### Web Search

- Azure AI Foundry Bing grounding for real-time web searches
- AI-powered result analysis and summarization
- Citation of sources with URLs
- Integrated directly into AI agent responses
- Optimized search query generation
- **Detailed Documentation**:
  - [Overview](./features/tools/README.md)
  - [Architecture & Workflows](./features/tools/architecture.md)
  - [Integration & Dependencies](./features/tools/integration.md)
  - [Development Guide](./features/tools/development.md)

### URL Content Puller

- Extract content from any webpage
- AI analysis of extracted content
- Custom questions about the content
- Automatic citation and source attribution
- Support for articles, documentation, and more

### File Upload & Processing

- Support for multiple file types (PDF, TXT, DOCX, etc.)
- File content analysis and Q&A
- Drag-and-drop upload interface
- File size validation and error handling

### Audio Transcription

- Whisper API integration for accurate transcription
- Support for multiple audio/video formats:
  - MP3, MP4, M4A, WAV
  - WebM, MPEG, MPG
- Real-time transcription status
- Copy or inject transcriptions into chat
- Download transcripts as TXT files
- Automatic retry with exponential backoff
- **Detailed Documentation**:
  - [Overview](./features/transcription/overview.md)
  - [Workflow](./features/transcription/workflow.md)
  - [Storage](./features/transcription/storage.md)
  - [Relevant Files](./features/transcription/relevant-files.md)
  - [Configuration](./features/transcription/configuration.md)
  - [Testing](./features/transcription/testing.md)

### Text-to-Speech

- Convert AI responses to audio
- Natural-sounding voice synthesis
- Playback controls
- Download audio files

### Image Upload & Vision

- Upload images for AI analysis
- Vision model support for image understanding
- Multi-image conversations
- Camera capture on mobile devices

### Language Translation

- Translate text between 13+ languages
- Multiple translation types:
  - Literal - Word-for-word translation
  - Balanced - Natural and accurate
  - Cultural - Context-aware adaptation
  - Figurative - Idiomatic expressions
- Domain-specific terminology:
  - General, Business, Legal, Technical, Medical
- Formal language option
- Gender-neutral language option
- Auto-detect source language

## User Interface

### Themes

- **Light Mode** - Clean, bright interface
- **Dark Mode** - Easy on the eyes for night use
- **System Sync** - Match OS preferences
- Persistent theme selection

### Sidebar

- **Conversations Tab** - Browse and manage chat history
- **Prompts Tab** - Access saved prompt templates
- **Search** - Quick filtering of conversations
- **Folders** - Organize with custom folders
- **User Profile** - Display user initials and info
- **Settings Access** - Quick settings button

### Responsive Design

- Desktop-optimized layout
- Mobile-friendly interface
- Touch-optimized controls
- Adaptive navigation

## Settings

### General

- **Language** - 33 supported languages
- **Theme** - Light/Dark mode selection
- **Display Options** - Customize interface preferences

### Chat Settings

- **Default Temperature** - Set initial creativity level
- **System Prompt** - Configure default AI instructions
- **Streaming Mode** - Enable/disable smooth streaming
- **Streaming Speed** - Characters per frame (1-10)
- **Frame Delay** - Delay between updates (5-50ms)

### Privacy Control

- Privacy policy viewer
- Terms of service
- Data usage information
- MSF-specific privacy guidelines

### Data Management

- **Export Data** - Download all conversations as JSON
- **Import Data** - Restore from backup
- **Clear Conversations** - Remove all chat history
- **Storage Monitor** - Track localStorage usage

### Account

- **User Information** - View profile details
- **Sign Out** - End session securely

## Accessibility

- Keyboard navigation support
- Screen reader compatibility
- ARIA labels and roles
- High contrast mode support
- Focus indicators
- Alt text for images

## Performance

### Smooth Streaming

- Configurable character-by-frame rendering
- Adjustable delay between frames
- More natural reading experience
- Reduced eye strain during long responses

### Storage Optimization

- Efficient localStorage usage
- Storage usage monitoring
- Automatic cleanup suggestions
- Conversation archiving

### Error Handling

- Graceful degradation on errors
- Automatic retry logic
- User-friendly error messages
- Network status detection

## Security & Privacy

- **Local Storage** - All data stored on your device
- **No Server Persistence** - Conversations never stored server-side
- **Azure Integration** - Enterprise-grade security
- **SSO Authentication** - Secure login via Azure AD
- **Session Management** - Automatic timeout and renewal
- **Data Control** - Full ownership of your data

## Internationalization

### Supported Languages

English, Spanish, French, German, Dutch, Italian, Portuguese, Russian, Chinese, Japanese, Korean, Arabic, Hindi, Amharic, Bengali, Catalan, Czech, Persian, Finnish, Hebrew, Indonesian, Burmese, Polish, Romanian, Sinhala, Swedish, Swahili, Telugu, Thai, Turkish, Ukrainian, Urdu, Vietnamese

### Translation Features

- Dynamic language switching
- Fallback to English for missing translations
- RTL support for Arabic, Hebrew, Persian
- Locale-specific formatting (dates, numbers)

## Developer Features

### API Routes

- RESTful API structure
- Clean endpoints (`/api/`)
- Streaming support
- Error handling middleware
- Type-safe request/response

### Extensibility

- Modular component architecture
- Custom hooks for reusability
- Zustand stores for state management
- Plugin-ready design
- Custom prompt system

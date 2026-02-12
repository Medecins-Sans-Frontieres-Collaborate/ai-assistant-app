# Architecture

## Overview

MSF AI Assistant is a Next.js 16 application built with the App Router, providing an AI chatbot interface powered by Azure OpenAI and Azure AI Foundry. The application uses modern React patterns with TypeScript and Zustand for state management.

## Technology Stack

### Core Framework

- **Next.js 16** - App Router architecture with Turbopack
- **React 19** - UI library with Server and Client Components
- **TypeScript 5.7** - Type-safe development with strict mode
- **Tailwind CSS 3.4** - Utility-first styling

### State Management

- **Zustand 5.0** - Lightweight state management with 4 stores:
  - `useUIStore` - UI state (theme, modals, sidebar)
  - `useSettingsStore` - User settings (temperature, system prompt, prompts, tones)
  - `useConversationStore` - Conversation management and folders
  - `useChatStore` - Active chat state and message handling

### Authentication

- **NextAuth.js v5 (beta.30)** - Authentication with Azure AD integration
- Session-based authentication with JWT
- Protected API routes

### Internationalization

- **next-intl** - App Router compatible i18n library
- Translation files in `messages/{locale}.json`
- Supports 33 languages with dynamic locale switching

### AI Integration

- **Azure OpenAI** - GPT models (GPT-4.1, GPT-5, o3) via Microsoft Azure
- **Azure AI Foundry** - Third-party models (DeepSeek, Grok, Llama)
- Streaming responses with custom smooth streaming implementation
- Support for function calling and structured outputs
- Chain of Responsibility pattern for request routing

## Directory Structure

```
/app                      # Next.js App Router
  /[locale]              # Internationalized pages
    /(chat)              # Chat page with loading states
  /api                   # API routes
    /agents              # AI agent validation
    /auth                # Authentication
    /chat                # Chat completion
    /file                # File upload/processing
    /prompts             # Prompt revision
    /tones               # Tone analysis
    /transcription       # Audio transcription
    /tts                 # Text-to-speech

/components               # React components
  /Chat                  # Chat interface
  /QuickActions          # Prompts and tones management
  /Providers             # Context providers
  /Settings              # Settings dialog
  /Sidebar               # Conversation sidebar
  /UI                    # Reusable components

/lib                      # Shared libraries
  /hooks                 # Custom React hooks
    /chat                # Chat hooks
    /conversation        # Conversation hooks
    /settings            # Settings hooks
    /ui                  # UI hooks
  /services              # Business logic
    /chat                # Chat service with handler chain
  /stores                # Zustand state stores
  /utils                 # Utility functions
    /app                 # Application utilities
    /server              # Server-side utilities

/messages                 # i18n translation files
/types                    # TypeScript type definitions
/config                   # Configuration files
/__tests__                # Test suite
  /dom                   # Component tests
  /node                  # Service/utility tests

/public                   # Static assets
/docs                     # Documentation
```

## Key Architectural Patterns

### 1. Chain of Responsibility - Chat Request Handling

The chat service uses a handler chain pattern for routing requests:

```typescript
// lib/services/chatService.ts
class ChatService {
  private handlers: ChatRequestHandler[];

  constructor() {
    this.handlers = [
      new ForcedAgentHandler(this.agentHandler),
      new RAGHandler(this.ragService, ...),
      new AIFoundryAgentChatHandler(this.agentHandler),
      new ReasoningModelHandler(...),
      new StandardModelChatHandler(...),
    ].sort((a, b) => a.getPriority() - b.getPriority());
  }

  async handleRequest(req: NextRequest): Promise<Response> {
    for (const handler of this.handlers) {
      if (handler.canHandle(context)) {
        return handler.handle(context);
      }
    }
  }
}
```

**Benefits:**

- Clean separation of concerns
- Easy to add new model types
- Testable in isolation
- Priority-based routing

### 2. Factory Pattern - Service Creation

```typescript
// lib/services/blobStorageFactory.ts
export function createBlobStorageClient(session: Session): BlobStorage {
  // Creates appropriate storage client based on environment
}

// lib/services/transcriptionService.ts
export class TranscriptionServiceFactory {
  static getTranscriptionService(type: 'whisper'): TranscriptionService {
    // Returns appropriate transcription service
  }
}
```

### 3. Custom Hooks Pattern - UI Logic Reuse

Recent refactoring introduced several generic, reusable hooks:

```typescript
// lib/hooks/ui/useModalForm.ts
// Handles modal + form state for any entity
const toneModal = useModalForm({
  initialState: { name: '', description: '', voiceRules: '' },
});

// lib/hooks/ui/useFolderManagement.ts
// Generic folder organization with drag-drop
const folderManager = useFolderManagement({ items: tones });

// lib/hooks/ui/useItemSearch.ts
// Generic search/filter across multiple fields
const search = useItemSearch({
  items: tones,
  searchFields: ['name', 'description', 'tags'],
});
```

**Benefits:**

- Eliminates code duplication
- Type-safe with generics
- Composable logic
- Testable in isolation

### 4. Standardized API Responses

All API routes use standardized response helpers:

```typescript
// lib/utils/server/apiResponse.ts
import {
  badRequestResponse,
  handleApiError,
  unauthorizedResponse,
} from '@/lib/utils/server/apiResponse';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return unauthorizedResponse();
  }

  if (!data.isValid) {
    return badRequestResponse('Invalid input', details);
  }

  try {
    // ... logic
    return successResponse({ result });
  } catch (error) {
    return handleApiError(error, 'Failed to process request');
  }
}
```

**Benefits:**

- Consistent error format
- Error codes for client handling
- Reduced boilerplate
- Type-safe responses

## Key Features

### Chat Interface

- Real-time streaming responses with smooth streaming mode
- Conversation management (create, edit, delete, search)
- Folder organization for conversations
- Message regeneration and editing
- Code syntax highlighting (Shiki)
- Markdown rendering with citation support
- Image upload and analysis (Vision models)
- File upload (PDF, DOCX, TXT, etc.)

### Advanced Features

- **Web Search** - Azure AI Foundry Bing grounding with AI analysis
- **URL Puller** - Extract and analyze content from URLs
- **Audio/Video Transcription** - Whisper API integration
- **Text-to-Speech** - Azure TTS for converting responses to audio
- **Language Translation** - Multi-language translation with domain-specific options
- **Custom Prompts** - Create and organize custom prompts with folders
- **Writing Tones** - Define and apply writing styles/tones to conversations
- **Custom Agents** - Azure AI Foundry agent integration
- **RAG (Retrieval Augmented Generation)** - Azure AI Search integration

### Settings Management

- **General Settings** - Language, theme, default model
- **Chat Settings** - Temperature, system prompt, streaming options
- **Privacy Control** - Privacy policy and terms acceptance
- **Data Management** - Import/export conversations, prompts, tones
- **Account Settings** - User information and profile
- **Mobile App Settings** - Mobile-specific configurations

### Storage Strategy

- **Client-Side Storage** - Browser localStorage for privacy
  - Conversation history
  - User preferences
  - Custom prompts and tones
  - Settings
- **Session Storage** - Temporary data (file uploads)
- **Azure Blob Storage** - Optional for file persistence
- **No Server Persistence** - Chat history never stored on servers

## Data Flow

### Client-Side Flow

1. User interacts with Chat component
2. Message processed by ChatInput handlers
3. Sent to `/api/chat` via fetch with streaming
4. Custom stream reader handles SSE responses
5. UI updates in real-time with smooth streaming
6. Conversation auto-saved to localStorage via Zustand store

### Server-Side Flow

1. API route receives request
2. Validates authentication via NextAuth session
3. ChatService routes request through handler chain
4. Appropriate handler processes request:
   - Standard models → Azure OpenAI API
   - Reasoning models → Special handling (no temperature)
   - Agent models → Azure AI Foundry Agent API
   - RAG enabled → Azure AI Search + LLM
5. Streams response back to client
6. Handles errors with standardized error responses

### File Upload Flow

1. User selects file in ChatInput
2. File validated (size, type, executable check)
3. Uploaded to `/api/file/upload`
4. Server validates using MIME type utilities
5. Stored in Azure Blob Storage or temp storage
6. URL returned to client
7. File reference included in chat message
8. Server processes file when needed (transcription, extraction)

## State Management Pattern

### Zustand Store Architecture

Each store is a focused slice of state with actions:

```typescript
// Example: Conversation Store
interface ConversationState {
  conversations: Conversation[];
  selectedConversation: Conversation | null;
  folders: FolderInterface[];

  // Actions
  addConversation: (conversation: Conversation) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  deleteConversation: (id: string) => void;
  selectConversation: (id: string) => void;
  // ... folder actions
}

const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      conversations: [],
      // ... implementation
    }),
    { name: 'conversations' },
  ),
);
```

### Store Separation

- **useUIStore**: UI-only state (theme, modals, sidebar open/closed)
- **useSettingsStore**: User preferences (temperature, models, API keys)
- **useConversationStore**: Conversation data and folders
- **useChatStore**: Active chat state, streaming, loading

### Custom Hooks for Complex Logic

Instead of bloating stores, complex logic moved to custom hooks:

```typescript
// lib/hooks/conversation/useConversations.ts
export const useConversations = () => {
  const store = useConversationStore();

  // Computed values
  const conversationsByFolder = useMemo(() => {
    // Group conversations by folder
  }, [store.conversations]);

  // Complex actions
  const duplicateConversation = useCallback((id: string) => {
    // Logic to duplicate
  }, []);

  return {
    ...store,
    conversationsByFolder,
    duplicateConversation,
  };
};
```

## Authentication Flow

1. User accesses application
2. NextAuth middleware checks session
3. If not authenticated → redirect to `/signin`
4. Azure AD SAML authentication
5. NextAuth creates session with JWT
6. Session cookie stored (httpOnly, secure)
7. User information available via `useSession()` hook
8. Protected API routes validate session:
   ```typescript
   const session = await auth();
   if (!session?.user) {
     return unauthorizedResponse();
   }
   ```

## Internationalization

### Translation Structure

- All translations in `messages/{locale}.json`
- 33 supported languages
- Parameterized translations supported
- Dynamic locale switching

### Usage Pattern

```typescript
import { useTranslations } from 'next-intl';

function Component() {
  const t = useTranslations();

  return <div>{t('Welcome')}</div>;
}
```

### Adding New Translation

1. Add key to `messages/en.json`
2. Add to other locale files
3. Use in component: `{t('YourKey')}`

## Performance Optimizations

- **Turbopack** - Faster dev builds with Next.js 16
- **Code Splitting** - Automatic route-based splitting
- **Server Components** - Reduced client JavaScript
- **Streaming** - Progressive content delivery for chat
- **Local Storage** - Offline-first data persistence
- **Memoization** - React.memo and useMemo/useCallback
- **Zustand** - Efficient re-renders (only subscribed components update)
- **Custom Hooks** - Logic reuse without component re-renders
- **Lazy Loading** - Components loaded on demand

## Security

### Authentication & Authorization

- **Enterprise SSO** - Azure AD SAML integration
- **Session Management** - Secure JWT sessions with httpOnly cookies
- **API Protection** - Server-side session validation on all routes
- **CSRF Protection** - Built-in via NextAuth

### Data Privacy

- **Client-Side Storage** - All conversations in localStorage
- **No Server Persistence** - Chat history never stored on servers
- **User Control** - Full data ownership and export capability
- **File Validation** - Executable file blocking, size limits

### Transport & Infrastructure

- **HTTPS Only** - Enforced in production
- **CSP Headers** - Content Security Policy configured
- **Environment Variables** - Secrets never in code
- **Azure Security** - Enterprise-grade Microsoft Azure infrastructure

## Deployment

### Environment Variables

Required variables (see `.env.example`):

```bash
# NextAuth
NEXTAUTH_URL=https://your-domain.com
NEXTAUTH_SECRET=your-secret-key

# Azure AD
AZURE_AD_CLIENT_ID=your-client-id
AZURE_AD_CLIENT_SECRET=your-client-secret
AZURE_AD_TENANT_ID=your-tenant-id

# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://your-openai.openai.azure.com/
# ... (see .env.example for complete list)
```

### Build Process

```bash
npm run build    # Production build with Turbopack
npm run start    # Start production server
npm test         # Run test suite
npm run lint     # Run linter
```

### Docker Support

```bash
docker build -t msf-ai-assistant .
docker run -p 3000:3000 --env-file .env.local msf-ai-assistant
```

### Azure Container Apps

See `docs/AZURE_CONTAINER_APPS.md` for deployment guide.

## Testing Strategy

### Test Organization

```
__tests__/
├── dom/           # Component tests (React Testing Library)
│   ├── components/  # Component unit tests
│   ├── hooks/       # Custom hook tests
│   └── stores/      # Store tests
├── node/          # Service/utility tests (Vitest)
│   ├── services/    # Service tests (ragService, chatService)
│   ├── stores/      # Store integration tests
│   └── utils/       # Utility function tests
└── e2e/           # End-to-end tests (Playwright)
```

### Testing Approach

- **Component Testing** - React Testing Library for UI components
- **Hook Testing** - Custom hook testing with renderHook
- **Service Testing** - Unit tests for business logic
- **API Testing** - Mock Azure OpenAI responses
- **Type Safety** - TypeScript strict mode enforced

### Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Generate coverage report
```

## Development Workflow

1. Feature development in feature branches
2. Local testing with `npm run dev`
3. Run tests with `npm test`
4. Type checking with `npm run type-check`
5. Build verification with `npm run build`
6. PR review and merge to main
7. Automated deployment via GitHub Actions

## Code Quality Standards

- **TypeScript Strict Mode** - Enforced for type safety
- **ESLint** - Code quality and consistency
- **Prettier** - Code formatting
- **Husky** - Pre-commit hooks
- **Conventional Commits** - Commit message standards

---

**Last Updated:** 2025-02-10
**Version:** 2.0
**Next.js:** 16.0.8
**React:** 19.2.0

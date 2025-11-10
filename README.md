# MSF AI Assistant

An enterprise AI chatbot interface built for Médecins Sans Frontières (MSF), powered by Azure OpenAI and Next.js 16.

## Overview

MSF AI Assistant provides a secure, privacy-focused chat interface for MSF staff to interact with large language models. All conversations are stored locally on the user's device, ensuring complete data privacy and control.

## Features

- 🤖 **AI Chat** - Streaming conversations with GPT models via Azure OpenAI
- 🔍 **Web Search** - Azure AI Foundry Bing grounding with AI analysis
- 🌐 **URL Analysis** - Extract and analyze content from any webpage
- 🎤 **Audio Transcription** - Whisper API integration for audio/video files
- 📁 **File Upload** - Support for PDFs, documents, and more
- 🖼️ **Vision** - Upload and analyze images
- 🌍 **Translation** - Multi-language translation with domain-specific options
- 💾 **Local Storage** - All data stored on your device for privacy
- 🎨 **Themes** - Light and dark mode support
- 🌐 **i18n** - Support for 33 languages
- 📱 **Responsive** - Works on desktop and mobile devices

For a complete feature list, see [docs/FEATURES.md](./docs/FEATURES.md).

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - Technical architecture and stack details
- [Features](./docs/FEATURES.md) - Complete feature documentation
- [Setup Guide](./docs/SETUP.md) - Development environment setup

## Quick Start

### Prerequisites

- Node.js 24+ and npm 10+
- Azure OpenAI or Azure AI Foundry API access
- Azure AD application for authentication

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/Medecins-Sans-Frontieres-Collaborate/ai-assistant-app.git
   cd ai-assistant-app
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment variables**

   Copy `.env.example` to `.env.local` and configure:

   ```bash
   cp .env.example .env.local
   ```

   Then edit `.env.local` with your actual values. See `.env.example` for all available configuration options and detailed descriptions of each variable.

4. **Run development server**

   ```bash
   npm run dev
   ```

5. **Open your browser**

   Navigate to [http://localhost:3000](http://localhost:3000)

## Development

### Project Structure

```
/app              # Next.js App Router pages and API routes
  /[locale]       # Internationalized pages
  /api            # API routes
/components       # React components
  /Chat           # Chat interface
  /QuickActions   # Prompts and tones management
  /Providers      # Context providers
  /Settings       # Settings UI
  /Sidebar        # Conversation sidebar
  /UI             # Reusable UI components
/lib              # Shared libraries and utilities
  /hooks          # Custom React hooks
  /services       # Business logic
  /stores         # Zustand state stores
  /utils          # Utility functions
/messages         # i18n translation files
/types            # TypeScript type definitions
/config           # Configuration files
/docs             # Documentation
/__tests__        # Test suite
```

### Tech Stack

- **Framework:** Next.js 16 (App Router with Turbopack)
- **Language:** TypeScript 5.7
- **UI Library:** React 19
- **Styling:** Tailwind CSS 3.4
- **State Management:** Zustand 5.0
- **Authentication:** NextAuth.js v5 (beta) with Azure AD
- **i18n:** next-intl (33 languages)
- **AI:** Azure OpenAI API + Azure AI Foundry
- **Testing:** Vitest + Testing Library

### Available Scripts

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint
npm run test         # Run all tests
```

## Deployment

### Docker

Build and run with Docker:

```bash
docker build -t msf-ai-assistant .
docker run -p 3000:3000 --env-file .env.local msf-ai-assistant
```

## Configuration

### Environment Variables

See `.env.example` for all available configuration options, including:

- NextAuth configuration (URL, secret, Azure AD)
- Azure OpenAI and Azure AI Foundry credentials and endpoints
- Optional services (Azure Blob Storage, Azure AI Search, LaunchDarkly)
- Application settings (environment, rate limiting)

Copy `.env.example` to `.env.local` and update with your actual values.

### Model Configuration

Model settings and environment-specific configurations are managed in two files:

**`types/openai.ts`** - Single source of truth for all model metadata:

- Model names, descriptions, token limits
- Agent IDs for Azure AI Foundry integration
- Model capabilities (streaming, temperature, etc.)

**`config/models.ts`** - Environment-specific overrides (localhost, dev, prod):

- Default model per environment
- Disabled models per environment

### Feature Flags

Feature flags are managed via LaunchDarkly. See `.env.example` for LaunchDarkly configuration options.

## Privacy & Security

- **Local Storage** - All conversations stored in browser localStorage
- **No Server Persistence** - Chat history never stored on servers
- **Azure Security** - Enterprise-grade security via Microsoft Azure
- **SSO** - Secure single sign-on with Azure AD
- **Data Control** - Users have full control over their data

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Write TypeScript with strict mode
- Follow existing code style
- Add tests for new features
- Update documentation as needed
- Ensure all types are properly defined

## Support

For issues, questions, or feature requests:

- Open an issue on GitHub
- Contact the MSF IT support team
- See internal MSF documentation

## Acknowledgments

Built with:

- [Next.js](https://nextjs.org/) - React framework
- [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service) - AI models
- [Tailwind CSS](https://tailwindcss.com/) - Styling
- [Zustand](https://github.com/pmndrs/zustand) - State management
- [NextAuth.js](https://next-auth.js.org/) - Authentication

---

**Note:** This is an internal MSF application. For MSF staff use only.

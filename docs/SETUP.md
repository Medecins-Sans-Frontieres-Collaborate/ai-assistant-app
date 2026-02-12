# Setup Guide

This guide will help you set up the MSF AI Assistant development environment from scratch.

## Prerequisites

### Required Software

- **Node.js** 24.x or higher
- **npm** 10.x or higher (comes with Node.js)
- **Git** for version control
- A code editor (VS Code recommended)

### Required Access

- Azure OpenAI or Azure AI Foundry API access
- Azure AD application credentials
- Optional: Azure Blob Storage, Azure AI Search, LaunchDarkly

## Installation Steps

### 1. Clone Repository

```bash
git clone https://github.com/Medecins-Sans-Frontieres-Collaborate/ai-assistant-app.git
cd ai-assistant-app
```

### 2. Install Dependencies

```bash
npm install
```

This will install all required packages including:

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- Zustand
- NextAuth.js v5
- And other dependencies

### 3. Environment Configuration

#### Create Environment File

Copy the example environment file:

```bash
cp .env.example .env.local
```

#### Configure Required Variables

Edit `.env.local` and add your actual credentials. The `.env.example` file contains detailed descriptions of all available environment variables.

**Minimum required variables:**

- `NEXTAUTH_URL` - Your application URL (e.g., http://localhost:3000)
- `NEXTAUTH_SECRET` - Generate with: `openssl rand -base64 32`
- `AZURE_AD_CLIENT_ID` - From Azure AD app registration
- `AZURE_AD_CLIENT_SECRET` - From Azure AD app registration
- `AZURE_AD_TENANT_ID` - From Azure AD
- `OPENAI_API_KEY` - From Azure OpenAI resource
- `AZURE_OPENAI_ENDPOINT` - From Azure OpenAI resource
- `DEFAULT_MODEL` - Your default model deployment name (e.g., gpt-4o)

**Optional variables:**

- `AZURE_AI_FOUNDRY_ENDPOINT` - For AI agents and third-party models
- `AZURE_BLOB_STORAGE_NAME` - For file uploads
- `SEARCH_ENDPOINT` / `SEARCH_ENDPOINT_API_KEY` - For Azure AI Search
- `LAUNCHDARKLY_CLIENT_ID` / `LAUNCHDARKLY_SDK_KEY` - For feature flags

See `.env.example` for complete documentation of all variables.

### 4. Azure Setup (Optional but Recommended)

Follow these steps to set up your Azure resources for the application.

#### Azure OpenAI Service

1. Navigate to [Azure Portal](https://portal.azure.com)
2. Create or navigate to your Azure OpenAI resource
3. Go to "Keys and Endpoint"
4. Copy:
   - API Key → `OPENAI_API_KEY`
   - Endpoint → `AZURE_OPENAI_ENDPOINT`
5. Go to "Model deployments"
6. Deploy required models:
   - GPT-5.2, GPT-4.1, or GPT-5-mini
   - (Optional) Whisper for transcription (deployment name must be "whisper")
   - (Optional) Text-embedding-ada-002 for embeddings
7. Copy your preferred default deployment name → `DEFAULT_MODEL`

#### Azure AD Application

1. Navigate to [Azure Portal](https://portal.azure.com)
2. Go to "Azure Active Directory" → "App registrations"
3. Click "New registration"
4. Configure:
   - Name: "MSF AI Assistant"
   - Supported account types: "Accounts in this organizational directory only"
   - Redirect URI: `http://localhost:3000/api/auth/callback/azure-ad`
5. Click "Register"
6. Copy "Application (client) ID" → `AZURE_AD_CLIENT_ID`
7. Copy "Directory (tenant) ID" → `AZURE_AD_TENANT_ID`
8. Go to "Certificates & secrets"
9. Create new client secret
10. Copy secret value → `AZURE_AD_CLIENT_SECRET`

### 5. Start Development Server

```bash
npm run dev
```

The application should now be running at [http://localhost:3000](http://localhost:3000)

## Verification

### Test Authentication

1. Navigate to http://localhost:3000
2. You should be redirected to `/signin`
3. Click "Sign in with Azure AD"
4. Complete Azure AD authentication
5. You should be redirected back to the chat interface

### Test Chat

1. After signing in, you should see the chat interface
2. Type a message and press Enter
3. You should see a streaming response from the AI

### Test Features

Try these features to ensure everything works:

- **Chat**: Send messages and receive responses
- **New Conversation**: Create a new conversation
- **Settings**: Open settings and change theme
- **Web Search** (if configured): Use the web search feature
- **File Upload**: Upload a text file
- **Audio Transcription** (if configured): Upload an audio file

## Troubleshooting

### Common Issues

**"Module not found" errors**

```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

**"Authentication failed"**

- Verify all Azure AD credentials in `.env.local` match `.env.example` format
- Check redirect URI is configured in Azure AD app registration
- Ensure `NEXTAUTH_URL` matches your application URL exactly
- Verify `NEXTAUTH_SECRET` is set and is a valid base64 string

**"Failed to fetch AI response"**

- Verify Azure OpenAI credentials
- Check API endpoint is correct
- Ensure model deployment exists and is named correctly
- Check API version is compatible

**"Build failed" with TypeScript errors**

```bash
# Build will show TypeScript errors
npm run build

# Fix reported errors before deploying
```

**Port 3000 already in use**

```bash
# Use a different port
PORT=3001 npm run dev
```

### Debug Mode

Enable debug logging:

```env
# Add to .env.local
DEBUG=true
NODE_ENV=development
```

### Check Logs

Development server logs appear in your terminal. Look for:

- API route errors
- Authentication issues
- Environment variable warnings

## IDE Setup

### VS Code (Recommended)

Install recommended extensions:

```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "bradlc.vscode-tailwindcss",
    "ms-vscode.vscode-typescript-next"
  ]
}
```

Configure settings (`.vscode/settings.json`):

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

## Git Hooks Setup

The project uses [Husky](https://typicode.github.io/husky/) for Git hooks with automated checks before commits.

### What's Included

**Pre-commit Hook:**

- **Secret Scanning** - Uses [secretlint](https://github.com/secretlint/secretlint) to detect:
  - AWS access keys
  - API keys (OpenAI, Google, etc.)
  - GitHub tokens
  - Private keys
  - Other sensitive credentials
- **Code Formatting** - Auto-formats code with Prettier
- **Linting** - Runs on JavaScript/TypeScript files

### Automatic Setup

Hooks are automatically installed when you run:

```bash
npm install
```

The `prepare` script in `package.json` runs `husky` which installs the Git hooks.

### Manual Hook Installation

If hooks weren't installed automatically:

```bash
npx husky install
```

### Running Checks Manually

Test the pre-commit hook without committing:

```bash
npx lint-staged
```

Run secret scanning on all files:

```bash
npx secretlint "**/*"
```

### Bypassing Hooks

**⚠️ Not recommended** - Only use in emergencies:

```bash
git commit --no-verify -m "your message"
```

### Configuration Files

- `.husky/pre-commit` - Pre-commit hook script
- `.secretlintrc.json` - Secret scanning rules
- `package.json` > `lint-staged` - Staged files configuration

### Troubleshooting

**Hook not running:**

```bash
# Reinstall hooks
npx husky install
```

**False positive in secret detection:**

```bash
# Add exception to .secretlintrc.json
{
  "rules": [
    {
      "id": "@secretlint/secretlint-rule-preset-recommend",
      "allowMessageIds": ["YOUR_PATTERN_ID"]
    }
  ]
}
```

**Want to add more checks:**

Edit `package.json` > `lint-staged`:

```json
"lint-staged": {
  "*": ["secretlint"],
  "*.{js,jsx,ts,tsx}": [
    "prettier --write"
  ]
}
```

## Next Steps

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) to understand the codebase
- Review [FEATURES.md](./FEATURES.md) for feature documentation
- Check existing issues and PRs on GitHub
- Join the development Slack channel (if applicable)

## Support

For setup help:

1. Check this documentation
2. Search existing GitHub issues
3. Contact the development team
4. Reach out on Slack (internal MSF)

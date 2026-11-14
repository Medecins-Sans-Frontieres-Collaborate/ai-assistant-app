/**
 * Entra ID (keyless) authentication for Azure AI Services data planes:
 * Azure OpenAI, Speech (speech-to-text and text-to-speech) and the grant
 * pipeline's OpenAI deployment. Server-only.
 *
 * The Foundry accounts run with local (key) authentication disabled, so every
 * caller authenticates as the application identity: the managed identity in
 * Azure, or whatever DefaultAzureCredential resolves to locally
 * (environment client secret, then the Azure CLI login). That identity needs
 * the data-plane role for each service it calls on the account:
 *  - Cognitive Services OpenAI User   (chat, Whisper)
 *  - Cognitive Services Speech User   (fast/batch transcription, TTS)
 *
 * Entra tokens are only accepted on an account's CUSTOM-DOMAIN endpoint
 * (`https://<name>.cognitiveservices.azure.com`), never on the regional
 * endpoints (`https://<region>.api.cognitive.microsoft.com`,
 * `wss://<region>.tts.speech.microsoft.com`) that key auth used.
 */
import { env } from '@/config/environment';
import {
  DefaultAzureCredential,
  TokenCredential,
  getBearerTokenProvider,
} from '@azure/identity';

/** Token audience for every Azure AI Services data plane. */
export const COGNITIVE_SERVICES_SCOPE =
  'https://cognitiveservices.azure.com/.default';

let sharedCredential: TokenCredential | null = null;
let sharedTokenProvider: (() => Promise<string>) | null = null;

/**
 * The application identity, shared so its token cache is reused across
 * services instead of every caller acquiring its own token.
 *
 * @returns The process-wide DefaultAzureCredential
 */
export function getApplicationCredential(): TokenCredential {
  sharedCredential ??= new DefaultAzureCredential();
  return sharedCredential;
}

/**
 * A bearer-token provider for the Cognitive Services scope, suitable for the
 * OpenAI SDK's `azureADTokenProvider` option. Tokens are cached and refreshed
 * by the provider before they expire.
 *
 * @returns A function resolving to a raw access token
 * @throws (from the returned function) CredentialUnavailableError or
 *   AuthenticationError when no identity can issue a token
 */
export function getCognitiveServicesTokenProvider(): () => Promise<string> {
  sharedTokenProvider ??= getBearerTokenProvider(
    getApplicationCredential(),
    COGNITIVE_SERVICES_SCOPE,
  );
  return sharedTokenProvider;
}

/**
 * The `Authorization` header for a direct REST call to an AI Services data
 * plane.
 *
 * @returns `{ Authorization: 'Bearer <token>' }`
 * @throws When no identity can issue a token
 */
export async function getCognitiveServicesAuthHeaders(): Promise<
  Record<string, string>
> {
  const token = await getCognitiveServicesTokenProvider()();
  return { Authorization: `Bearer ${token}` };
}

/** True when `endpoint` is an account custom domain, which Entra requires. */
export function isCustomDomainEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.endsWith('.cognitiveservices.azure.com');
  } catch {
    return false;
  }
}

/**
 * The Speech data-plane endpoint, without a trailing slash.
 *
 * `AZURE_SPEECH_ENDPOINT` wins when set. Otherwise the Speech service of the
 * account behind `AZURE_OPENAI_ENDPOINT` is used: it is the same AI Services
 * account whose key Speech used before keys were disabled, so routing is
 * unchanged.
 *
 * A regional endpoint is rejected (with one warning) rather than returned:
 * it would accept the request and answer 401, which reads as a missing role
 * instead of a configuration error.
 *
 * @returns The endpoint, or undefined when none usable is configured
 */
export function resolveSpeechEndpoint(): string | undefined {
  const endpoint = env.AZURE_SPEECH_ENDPOINT || env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) return undefined;
  if (!isCustomDomainEndpoint(endpoint)) {
    if (!warnedRegionalSpeechEndpoint) {
      warnedRegionalSpeechEndpoint = true;
      console.warn(
        `[cognitiveServicesAuth] Speech endpoint ${new URL(endpoint).host} is not an account custom domain (*.cognitiveservices.azure.com); Entra authentication needs one. Set AZURE_SPEECH_ENDPOINT to the account endpoint.`,
      );
    }
    return undefined;
  }
  return endpoint.replace(/\/+$/, '');
}

let warnedRegionalSpeechEndpoint = false;

/**
 * Resets the shared credential and token provider. Tests only.
 */
export function resetCognitiveServicesAuthForTests(): void {
  sharedCredential = null;
  sharedTokenProvider = null;
  warnedRegionalSpeechEndpoint = false;
}

import tiktokenModel from '@dqbd/tiktoken/encoders/cl100k_base.json';
import { Tiktoken, init } from '@dqbd/tiktoken/lite/init';
import fs from 'fs';
import path from 'path';

/**
 * Global Tiktoken instance for token counting.
 * Initialized once and reused across all requests.
 */
let globalTiktoken: Tiktoken | null = null;
let initializationPromise: Promise<Tiktoken> | null = null;

/**
 * Gets the global Tiktoken instance.
 * Initializes it on first call and reuses it thereafter.
 *
 * Performance improvement:
 * - Before: ~50-100ms per request (WASM load + instantiation)
 * - After: ~0ms per request (reuse existing instance)
 *
 * Thread safety:
 * - Uses a promise to ensure single initialization even with concurrent calls
 *
 * @returns Promise that resolves to the Tiktoken instance
 */
export async function getGlobalTiktoken(): Promise<Tiktoken> {
  // If already initialized, return immediately
  if (globalTiktoken) {
    return globalTiktoken;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    return initializationPromise;
  }

  // Start initialization
  console.log('[TiktokenCache] Initializing global Tiktoken instance...');

  initializationPromise = (async () => {
    try {
      const wasmPath = path.resolve(
        './node_modules/@dqbd/tiktoken/lite/tiktoken_bg.wasm',
      );

      const wasmBuffer = fs.readFileSync(wasmPath);
      await init((imports) => WebAssembly.instantiate(wasmBuffer, imports));

      globalTiktoken = new Tiktoken(
        tiktokenModel.bpe_ranks,
        tiktokenModel.special_tokens,
        tiktokenModel.pat_str,
      );

      console.log('[TiktokenCache] Tiktoken initialized successfully');

      return globalTiktoken;
    } catch (error) {
      console.error('[TiktokenCache] Failed to initialize Tiktoken:', error);
      // Reset promise so it can be retried
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Resets the global Tiktoken instance.
 * Only use this for testing purposes.
 */
export function resetGlobalTiktoken(): void {
  if (globalTiktoken) {
    globalTiktoken.free();
    globalTiktoken = null;
  }
  initializationPromise = null;
  console.log('[TiktokenCache] Reset global Tiktoken instance');
}

/**
 * Counts tokens in a string using the cached Tiktoken instance.
 *
 * @param text - The text to count tokens for
 * @returns Promise that resolves to the token count
 */
export async function countTokens(text: string): Promise<number> {
  const tiktoken = await getGlobalTiktoken();
  const tokens = tiktoken.encode(text);
  return tokens.length;
}

/**
 * Encodes text to tokens using the cached Tiktoken instance.
 *
 * @param text - The text to encode
 * @returns Promise that resolves to the token array
 */
export async function encodeText(text: string): Promise<Uint32Array> {
  const tiktoken = await getGlobalTiktoken();
  return tiktoken.encode(text);
}

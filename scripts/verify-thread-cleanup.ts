/**
 * Manual end-to-end probe for Azure AI Foundry thread cleanup.
 *
 * What it does:
 *   1. Creates a thread directly via the SDK (simulates what a web search would create).
 *   2. Deletes it (via the SDK, mirroring what AIFoundryAgentHandler does in production).
 *   3. Calls threads.get(threadId) and asserts the resulting error is a 404.
 *
 * Exit codes: 0 on confirmed delete, 1 on any unexpected outcome.
 *
 * Usage:
 *   AZURE_AI_FOUNDRY_ENDPOINT=https://...services.ai.azure.com \
 *     npx ts-node --project tsconfig.scripts.json scripts/verify-thread-cleanup.ts
 *
 * Requires Azure credentials available to DefaultAzureCredential
 * (az login / managed identity / env vars — same as the production app).
 */
import { AgentsClient } from '@azure/ai-agents';
import { DefaultAzureCredential } from '@azure/identity';

async function main(): Promise<void> {
  const endpoint = process.env.AZURE_AI_FOUNDRY_ENDPOINT;
  if (!endpoint) {
    console.error('AZURE_AI_FOUNDRY_ENDPOINT is required');
    process.exit(1);
  }

  const client = new AgentsClient(endpoint, new DefaultAzureCredential());

  console.log('[verify-thread-cleanup] Creating ephemeral test thread...');
  const created = await client.threads.create();
  const threadId = created.id;
  console.log('[verify-thread-cleanup] Created thread:', threadId);

  console.log('[verify-thread-cleanup] Deleting thread...');
  const deleteResult = await client.threads.delete(threadId);
  if (deleteResult?.deleted !== true) {
    console.error(
      '[verify-thread-cleanup] FAIL: deleted flag was not true:',
      deleteResult,
    );
    process.exit(1);
  }
  console.log('[verify-thread-cleanup] Delete confirmed:', deleteResult);

  console.log('[verify-thread-cleanup] Verifying via threads.get(...)...');
  try {
    const got = await client.threads.get(threadId);
    console.error(
      '[verify-thread-cleanup] FAIL: threads.get returned a thread instead of 404:',
      got,
    );
    process.exit(1);
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const code = (err as { code?: string })?.code;
    if (statusCode === 404 || code === 'NotFound') {
      console.log(
        '[verify-thread-cleanup] PASS: threads.get reported 404 as expected.',
      );
      process.exit(0);
    }
    console.error(
      '[verify-thread-cleanup] FAIL: threads.get errored with non-404:',
      err,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[verify-thread-cleanup] Unexpected error:', err);
  process.exit(1);
});

import { getIndexConfig } from '../config/index-config';

import { DefaultAzureCredential } from '@azure/identity';
import { SearchIndexClient } from '@azure/search-documents';

export async function createOrUpdateIndex(
  indexName: string,
  allowIndexDowntime: boolean = false,
  endpoint: string,
  openaiEndpoint: string,
  openaiEmbeddingDeployment: string,
  searchApiKey?: string,
) {
  console.log(`Creating/updating index: ${indexName}`);
  console.log(`Allow index downtime: ${allowIndexDowntime}`);
  console.log('Using managed identity for authentication');

  try {
    // Get the index config with all settings
    const indexConfig = getIndexConfig(
      indexName,
      openaiEndpoint,
      openaiEmbeddingDeployment,
    );
    const options = allowIndexDowntime
      ? { allowIndexDowntime: true }
      : undefined;

    if (endpoint) {
      // Build auth header: use API key if provided, otherwise managed identity
      let authHeader: Record<string, string>;
      if (searchApiKey) {
        authHeader = { 'api-key': searchApiKey };
      } else {
        const credential = new DefaultAzureCredential();
        const token = await credential.getToken(
          'https://search.azure.com/.default',
        );
        authHeader = { Authorization: `Bearer ${token.token}` };
      }

      try {
        const rawJson = JSON.stringify(indexConfig);
        console.log('Index configuration being sent:', rawJson);

        const response = await fetch(
          `${endpoint}/indexes/${indexName}?api-version=2025-09-01`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...authHeader,
            },
            body: rawJson,
          },
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Direct API call failed: ${response.status} ${errorText}`,
          );
        }

        console.log(
          `Index ${indexName} created successfully via direct API call`,
        );
        return indexName;
      } catch (directApiError) {
        console.warn(directApiError);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error creating/updating index: ${errorMessage}`);
    throw error;
  }
}

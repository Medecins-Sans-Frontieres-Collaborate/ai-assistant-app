import { getSkillsetConfig } from '../config/skillset-config';

import { DefaultAzureCredential } from '@azure/identity';

export async function createOrUpdateSkillset(
  skillsetName: string,
  indexName: string,
  endpoint: string,
  openaiEndpoint: string,
  openaiEmbeddingDeployment: string,
  searchApiKey?: string,
) {
  console.log(`Creating/updating skillset: ${skillsetName}`);

  const skillsetConfig = getSkillsetConfig(
    skillsetName,
    indexName,
    openaiEndpoint,
    openaiEmbeddingDeployment,
  );

  try {
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

    const rawJson = JSON.stringify(skillsetConfig);
    console.log('Skillset configuration being sent:', rawJson);

    const response = await fetch(
      `${endpoint}/skillsets/${skillsetName}?api-version=2024-11-01-preview`,
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
      `Skillset ${skillsetName} created successfully via direct API call`,
    );
    return skillsetName;
  } catch (directApiError) {
    console.warn(directApiError);
  }
}

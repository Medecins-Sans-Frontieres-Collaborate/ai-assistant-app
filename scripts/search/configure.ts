import { createOrUpdateDataSource } from './components/create-datasource';
import { createOrUpdateIndex } from './components/create-index';
import { createOrUpdateIndexer } from './components/create-indexer';
import { createOrUpdateSkillset } from './components/create-skillset';

import { DefaultAzureCredential } from '@azure/identity';
import {
  AzureKeyCredential,
  SearchIndexerClient,
} from '@azure/search-documents';

export interface SearchConfig {
  endpoint: string;
  indexName: string;
  skillsetName: string;
  dataSourceName: string;
  indexerName: string;
  resourceId: string;
  containerName: string;
  allowIndexDowntime?: boolean;
  openaiEndpoint: string;
  openaiApiKey?: string;
  openaiEmbeddingDeployment: string;
  searchApiKey?: string;
}

export async function configureSearch(config: SearchConfig) {
  console.log('Starting Azure Search configuration for RAG system...');

  const apiVersion = '2024-11-01-preview';

  // Use API key if provided, otherwise fall back to managed identity
  const credential = config.searchApiKey
    ? new AzureKeyCredential(config.searchApiKey)
    : new DefaultAzureCredential();

  console.log(
    `Using ${config.searchApiKey ? 'API key' : 'managed identity (DefaultAzureCredential)'} for authentication`,
  );

  const indexerClient = new SearchIndexerClient(config.endpoint, credential, {
    apiVersion,
  });

  try {
    // Create components in the right order

    /*
    Creating VectorProfile with SDK doesn't seem to work.
    Using direct API call instead.
    */
    await createOrUpdateIndex(
      config.indexName,
      config.allowIndexDowntime,
      config.endpoint,
      config.openaiEndpoint,
      config.openaiEmbeddingDeployment,
      config.searchApiKey,
    );

    /*
    data source seems to have issues for inital creation with system managed identities
    but seems fine updating after creation
    */
    await createOrUpdateDataSource(
      indexerClient,
      config.dataSourceName,
      config.resourceId,
      config.containerName,
    );

    await createOrUpdateSkillset(
      config.skillsetName,
      config.indexName,
      config.endpoint,
      config.openaiEndpoint,
      config.openaiEmbeddingDeployment,
      config.searchApiKey,
    );

    await createOrUpdateIndexer(
      indexerClient,
      config.indexerName,
      config.dataSourceName,
      config.indexName,
      config.skillsetName,
    );

    console.log('Azure Search configuration completed successfully!');
  } catch (error) {
    console.error('Error configuring Azure Search:', error);
    throw error;
  }
}

import { SearchConfig, configureSearch } from './configure';

import * as fs from 'fs';
import * as path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  console.log('Loading environment from .env.local');
  require('dotenv').config({ path: envPath });
  // This only runs in local development
}

async function main() {
  // Check for allowIndexDowntime in arguments or environment
  const allowDowntime =
    process.env.ALLOW_INDEX_DOWNTIME === 'true' ||
    process.argv.includes('--allow-downtime');

  console.log(`Allow index downtime: ${allowDowntime}`);

  // Get all configuration from environment variables
  const config: SearchConfig = {
    endpoint: process.env.SEARCH_ENDPOINT || '',
    indexName: process.env.SEARCH_INDEX || '',
    skillsetName: process.env.SEARCH_SKILLSET || 'rag-skillset',
    dataSourceName: process.env.SEARCH_DATASOURCE || '',
    indexerName: process.env.SEARCH_INDEXER || '',
    containerName: process.env.STORAGE_DATA_SOURCE_CONTAINER || '',
    resourceId: process.env.STORAGE_RESOURCE_ID || '',
    allowIndexDowntime: allowDowntime,
    openaiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    searchApiKey: process.env.SEARCH_API_KEY || '',
    openaiEmbeddingDeployment:
      process.env.OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small',
  };

  // Validate required config
  const missingVars = Object.entries(config)
    .filter(
      ([key, value]) =>
        !value &&
        key !== 'allowIndexDowntime' &&
        key !== 'openaiApiKey' &&
        key !== 'searchApiKey',
    )
    .map(([key, _]) => key);

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(', ')}`,
    );
  }

  try {
    await configureSearch(config);
    console.log('Search configuration completed successfully!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { configureSearch };

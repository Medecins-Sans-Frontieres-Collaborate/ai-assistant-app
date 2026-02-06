import { SearchIndexerDataSourceConnection } from '@azure/search-documents';

export function getDataSourceConfig(
  dataSourceName: string,
  resourceId: string,
  containerName: string,
): SearchIndexerDataSourceConnection {
  return {
    name: dataSourceName,
    description: 'Data source for msf comms articles',
    type: 'azureblob',
    connectionString: `ResourceId=${resourceId};`,
    container: {
      name: containerName,
    },
  };
}

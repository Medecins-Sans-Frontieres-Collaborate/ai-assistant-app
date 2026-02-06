export function getSkillsetConfig(
  skillsetName: string,
  indexName: string,
  openaiEndpoint: string,
  openaiEmbeddingDeployment: string,
) {
  return {
    name: skillsetName,
    description: 'Skillset to chunk documents and generate embeddings',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: '#1',
        description: 'Split skill to chunk documents',
        context: '/document',
        defaultLanguageCode: 'en',
        textSplitMode: 'pages',
        maximumPageLength: 2000,
        pageOverlapLength: 500,
        maximumPagesToTake: 0,
        unit: 'characters',
        inputs: [
          {
            name: 'text',
            source: '/document/content',
            inputs: [],
          },
        ],
        outputs: [
          {
            name: 'textItems',
            targetName: 'pages',
          },
        ],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
        name: '#2',
        context: '/document/pages/*',
        resourceUri: openaiEndpoint,
        deploymentId: openaiEmbeddingDeployment,
        dimensions: 1536,
        modelName: 'text-embedding-3-small',
        inputs: [
          {
            name: 'text',
            source: '/document/pages/*',
            inputs: [],
          },
        ],
        outputs: [
          {
            name: 'embedding',
            targetName: 'text_vector',
          },
        ],
      },
    ],
    indexProjections: {
      selectors: [
        {
          targetIndexName: indexName,
          parentKeyFieldName: 'parent_id',
          sourceContext: '/document/pages/*',
          mappings: [
            {
              name: 'text_vector',
              source: '/document/pages/*/text_vector',
              inputs: [],
            },
            {
              name: 'chunk',
              source: '/document/pages/*',
              inputs: [],
            },
            {
              name: 'title',
              source: '/document/title',
              inputs: [],
            },
            {
              name: 'url',
              source: '/document/url',
              inputs: [],
            },
            {
              name: 'date',
              source: '/document/date',
              inputs: [],
            },
            {
              name: 'title_Data_Column',
              source: '/document/title',
              inputs: [],
            },
            {
              name: 'metadata_storage_content_type',
              source: '/document/metadata_storage_content_type',
              inputs: [],
            },
            {
              name: 'metadata_storage_size',
              source: '/document/metadata_storage_size',
              inputs: [],
            },
            {
              name: 'metadata_storage_last_modified',
              source: '/document/metadata_storage_last_modified',
              inputs: [],
            },
            {
              name: 'metadata_storage_content_md5',
              source: '/document/metadata_storage_content_md5',
              inputs: [],
            },
            {
              name: 'metadata_storage_name',
              source: '/document/metadata_storage_name',
              inputs: [],
            },
            {
              name: 'metadata_storage_path',
              source: '/document/metadata_storage_path',
              inputs: [],
            },
            {
              name: 'metadata_storage_file_extension',
              source: '/document/metadata_storage_file_extension',
              inputs: [],
            },
          ],
        },
      ],
      parameters: {
        projectionMode: 'skipIndexingParentDocuments',
      },
    },
  };
}

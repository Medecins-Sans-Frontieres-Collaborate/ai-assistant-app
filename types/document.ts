export interface DocumentUploadResponse {
  id: number;
  file_name: string;
  file_type: string;
  blob_url: string;
  uploaded_by: number | string;
  created_at: string;
}

export interface DocumentTranslationResponse {
  job_id: string;
  target_sas_url: string;
}

export interface DocumentTranslationStatusResponse {
  job_id: string;
  status: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | string;
  succeeded?: number;
  error?: string | null;
  translated_blob_name?: string | null;
}

export interface DocumentCostResponse {
  blob_name: string;
  characters: number;
  estimated_cost: number; // in currency units used by the service
}

export interface DocumentTranslationRequest {
  file: File;
  sourceLanguage: string; // 'en'
  targetLanguage: string; // 'fr'
}

export interface DocumentResponse {
  id: number;
  blob_name: string;
  filename: string;
  size: number;
  content_type: string;
  uploaded_by: number | string;
  uploaded_at: string; // ISO timestamp
  department?: string | null;
}

export interface DocumentTranslationResponse {
  job_id: string;
  document_id: number;
  source_language: string;
  target_language: string;
  status: string;
  translated_blob_name?: string | null;
  created_at: string;
  updated_at?: string | null;
  estimated_cost?: number | null;
}

export interface DocumentTranslationStatusResponse {
  job_id: string;
  status: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | string;
  succeeded?: number;
  error?: string | null;
  translated_blob_name?: string | null;
}

export interface DocumentCostResponse {
  characters: number;
  estimated_cost: number; // in currency units used by the service
}

// Request payload shapes used by the client
export interface TranslateDocumentRequest {
  document_id: number;
  user_id: number | string;
  source_lang?: string;
  target_lang: string;
}

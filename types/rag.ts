import { Message } from './chat';

export interface SearchResult {
  chunk: string;
  chunk_id?: string;
  title: string;
  date: string;
  url: string;

  '@search.captions'?: {
    text: string;
    highlights: string;
  }[];
  '@search.rerankerScore'?: number;
  '@search.score'?: number;
}

export interface DateRange {
  newest: string | null;
  oldest: string | null;
}

export interface RAGResponse {
  answer: string;
  sources_used: Array<{
    title: string;
    date: string;
    url: string;
    number: number;
  }>;
  sources_date_range: DateRange;
  total_sources: number;
}

export interface Citation {
  title: string;
  date: string;
  url: string;
  number: number;
  /**
   * True publisher name when `url` is an aggregator/redirect link (Google
   * News). Cards prefer this label so source diversity stays visible even
   * when link resolution fell back to the redirect URL.
   */
  sourceName?: string;
  /** Publisher site URL — drives the favicon/domain display when set. */
  sourceUrl?: string;
}

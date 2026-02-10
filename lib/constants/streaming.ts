/**
 * Standard headers for streaming HTTP responses.
 *
 * Includes `X-Accel-Buffering: no` to signal reverse proxies (nginx, Azure
 * Container Apps Envoy ingress) to disable response buffering so chunks are
 * forwarded immediately.
 */
export const STREAMING_RESPONSE_HEADERS: HeadersInit = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

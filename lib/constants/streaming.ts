/**
 * Standard headers for streaming HTTP responses.
 *
 * Includes `X-Accel-Buffering: no` to signal reverse proxies (nginx, Azure
 * Container Apps Envoy ingress) to disable response buffering so chunks are
 * forwarded immediately.
 *
 * `X-Content-Type-Options: nosniff` matters just as much: browsers MIME-sniff
 * `text/plain` bodies to tell text from binary, and the sniffer (Chromium's
 * MimeSniffingURLLoader, Firefox's binary detector) holds the first ~1 KB of
 * the response before `fetch()` sees a single byte. The pre-model activity
 * markers ("Searching: …", "Reading document…", the heartbeat) are ~150 bytes
 * each, so without this header they sat in that buffer until the model's
 * text pushed them out — the loader showed "Thinking…" through the whole
 * search. Markers inside the tool loop were unaffected only because 1 KB had
 * already flowed by then.
 */
export const STREAMING_RESPONSE_HEADERS: HeadersInit = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
};

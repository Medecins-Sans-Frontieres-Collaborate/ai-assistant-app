type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Fetch wrapper for OAuth token/refresh calls that normalizes a provider
 * quirk: GitHub's token endpoint (and a few others) reports failures as
 * HTTP **200** with an `error` field in the JSON body. The MCP SDK treats
 * any 2xx as success and feeds the body straight to OAuthTokensSchema,
 * which fails with an opaque ZodError ("access_token: expected string,
 * received undefined") that swallows the provider's actual message —
 * `redirect_uri_mismatch`, `incorrect_client_credentials`,
 * `bad_verification_code` all become indistinguishable.
 *
 * A 2xx JSON body carrying a string `error` is re-written to HTTP 400 so
 * the SDK's parseErrorResponse path surfaces `error`/`error_description`
 * verbatim. Everything else passes through byte-identical (the body is
 * re-wrapped because inspecting it consumes the stream).
 */
export function withOauthErrorNormalization(fetchFn?: FetchLike): FetchLike {
  const inner: FetchLike = fetchFn ?? fetch;
  return async (input, init) => {
    const response = await inner(input, init);
    if (!response.ok) return response;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) return response;

    const body = await response.text();
    let errorField: unknown;
    try {
      errorField = (JSON.parse(body) as { error?: unknown }).error;
    } catch {
      errorField = undefined;
    }
    return new Response(body, {
      status: typeof errorField === 'string' ? 400 : response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

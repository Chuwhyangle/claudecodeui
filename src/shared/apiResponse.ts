//----------------- HTTP RESPONSE ENVELOPE HELPERS ------------

/**
 * Reads a fetch Response body as JSON.
 *
 * Shared by the MCP servers, provider skills and settings controllers, which
 * all consume `{ success, data?, error?, details? }` envelopes and inspect
 * `response.ok`/`success` themselves rather than through `readApiJson` (whose
 * throwing contract would change their error handling).
 */
export const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

/**
 * Extracts a display message from an API error envelope.
 *
 * Accepts the structured form (`{ error: { message } }`), the legacy string
 * form (`{ error: 'message' }`), a top-level `details` string, and falls back
 * to the caller's message when none of those carry a non-blank string.
 * Shared by the MCP servers, provider skills and settings modules so every
 * surface parses the error envelope the same way.
 */
export const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  const details = record.details;
  if (typeof details === 'string' && details.trim()) {
    return details;
  }

  return fallback;
};

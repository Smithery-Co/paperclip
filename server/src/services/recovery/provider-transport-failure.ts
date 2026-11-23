/**
 * Pre-response provider transport failures.
 *
 * A provider request can die at the socket/TLS layer before any response bytes
 * arrive: a TLS handshake that never completes (`EPROTO`), a connection reset,
 * or a keep-alive socket the peer tore down while it sat in the pool. Nothing
 * was generated, so replaying the turn cannot duplicate tool calls.
 *
 * This is the legacy-adapter twin of the native runtime's
 * `provider_transport_failed` code and deliberately shares its vocabulary so
 * recovery, retry and dashboards see one name for one condition.
 *
 * The match set is intentionally narrow. Provider authentication, quota and
 * model-selection messages describe constraints a retry cannot repair, and
 * classifying them as transport failures would only manufacture more wasted
 * runs — a missing `OPENROUTER_API_KEY` already produced six consecutive
 * `adapter_failed` retries on 2026-11-23. DNS failures (`ENOTFOUND`,
 * `EAI_AGAIN`) are also excluded: they are usually a misconfigured host, not a
 * transient socket event.
 */
export const PROVIDER_TRANSPORT_FAILURE_CODE = "provider_transport_failed";

const TRANSPORT_FAILURE_PATTERNS: readonly RegExp[] = [
  /\bEPROTO\b/,
  /TLS handshake failed/i,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bEPIPE\b/,
  /socket hang ?up/i,
  /\bUND_ERR_(?:SOCKET|CLOSED|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)\b/,
];

/**
 * Constraints that must keep their own classification. Checked first so a
 * message that happens to embed a transport token cannot be promoted into a
 * retryable transport failure.
 */
const NON_TRANSPORT_PATTERNS: readonly RegExp[] = [
  /api key (?:is )?missing/i,
  /api key has expired/i,
  /invalid api key/i,
  /authentication_required/i,
  /\bunauthorized\b/i,
  /\b401\b/,
  /model is unavailable/i,
  /model is not supported/i,
  /configured opencode model is unavailable/i,
  /permission denied/i,
];

/**
 * True when `value` describes a transport failure that happened before the
 * provider produced a response, and therefore can be retried without
 * replaying generated work.
 */
export function isProviderTransportFailureMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const message = value.trim();
  if (message === "") return false;
  if (NON_TRANSPORT_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }
  return TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Resolve the recorded error code for a failed run, falling back to the
 * transport-failure code when the adapter left the message unpromoted.
 */
export function resolveProviderFailureErrorCode(input: {
  explicitErrorCode?: string | null;
  errorMessage?: string | null;
}): string | null {
  if (input.explicitErrorCode) return input.explicitErrorCode;
  return isProviderTransportFailureMessage(input.errorMessage)
    ? PROVIDER_TRANSPORT_FAILURE_CODE
    : null;
}

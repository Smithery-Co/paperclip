import { describe, expect, it } from "vitest";
import {
  PROVIDER_TRANSPORT_FAILURE_CODE,
  isProviderTransportFailureMessage,
  resolveProviderFailureErrorCode,
} from "./provider-transport-failure.js";

// Verbatim from the opencode session error event in run
// e811b90f-8b07-44e8-9840-4affffd62470 (THE-374, 2026-11-20 18:36:16Z).
const EPROTO_MESSAGE =
  "EPROTO: The TLS handshake failed. Does the server speak TLS on this port?";

describe("isProviderTransportFailureMessage", () => {
  it("recognizes the observed EPROTO handshake failure", () => {
    expect(isProviderTransportFailureMessage(EPROTO_MESSAGE)).toBe(true);
  });

  it.each([
    "EPROTO: The TLS handshake failed. Does the server speak TLS on this port?",
    "TLS handshake failed",
    "read ECONNRESET",
    "connect ECONNREFUSED 127.0.0.1:443",
    "connect ETIMEDOUT",
    "write EPIPE",
    "socket hang up",
    "fetch failed: UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
  ])("classifies %s as a transport failure", (message) => {
    expect(isProviderTransportFailureMessage(message)).toBe(true);
  });

  it.each([
    // Observed on 2026-11-23: six consecutive runs retried a missing key.
    "OpenRouter API key is missing. Pass it using the 'apiKey' parameter or the OPENROUTER_API_KEY environment variable.",
    "This API key has expired",
    "invalid api key",
    "authentication_required",
    "Configured OpenCode model is unavailable: opencode-go/deepseek-v4.1-flash-free",
    "The selected model is not supported by the current connection",
    "permission denied",
    "HTTP 401 Unauthorized",
  ])("does not promote the non-retryable constraint %s", (message) => {
    expect(isProviderTransportFailureMessage(message)).toBe(false);
  });

  it("does not classify a transport token embedded in an auth message", () => {
    expect(
      isProviderTransportFailureMessage(
        "unauthorized: upstream reset the connection (ECONNRESET)",
      ),
    ).toBe(false);
  });

  it("ignores empty and non-string input", () => {
    expect(isProviderTransportFailureMessage("")).toBe(false);
    expect(isProviderTransportFailureMessage("   ")).toBe(false);
    expect(isProviderTransportFailureMessage(null)).toBe(false);
    expect(isProviderTransportFailureMessage(undefined)).toBe(false);
    expect(isProviderTransportFailureMessage({ message: EPROTO_MESSAGE })).toBe(
      false,
    );
  });
});

describe("resolveProviderFailureErrorCode", () => {
  it("keeps an explicit adapter code", () => {
    expect(
      resolveProviderFailureErrorCode({
        explicitErrorCode: "workspace_validation_failed",
        errorMessage: EPROTO_MESSAGE,
      }),
    ).toBe("workspace_validation_failed");
  });

  it("promotes an unpromoted transport message", () => {
    expect(
      resolveProviderFailureErrorCode({
        explicitErrorCode: null,
        errorMessage: EPROTO_MESSAGE,
      }),
    ).toBe(PROVIDER_TRANSPORT_FAILURE_CODE);
  });

  it("returns null when the message describes a constraint, so callers keep their default", () => {
    expect(
      resolveProviderFailureErrorCode({
        explicitErrorCode: null,
        errorMessage: "OpenRouter API key is missing.",
      }),
    ).toBeNull();
  });
});

import { isPublicBaseUrl, resolveBaseUrl, resolveKey } from "../config";
import { CliError, EXIT_API, EXIT_AUTH, EXIT_TIMEOUT } from "../output/exit";
import { VERSION } from "../version";

export interface ClientOptions {
  key?: string;
  baseUrl?: string;
  retries?: boolean;
  timeoutMs?: number;
  requireKey?: boolean;
}

export interface ApiErrorBody {
  type?: string;
  request_id?: string;
  error?: { code?: string; message?: string; details?: unknown };
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly key: string | undefined;
  private readonly retries: boolean;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.key = resolveKey(options.key).key;
    if (options.requireKey === true && !this.key && isPublicBaseUrl(this.baseUrl)) {
      throw new CliError(
        "missing_api_key",
        "missing or invalid API key — set CAESAR_API_KEY",
        EXIT_AUTH,
        "Set CAESAR_API_KEY or run: caesar-search auth login",
      );
    }
    this.retries = options.retries ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Caesar-Client": `cli/${VERSION}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.key) headers.Authorization = `Bearer ${this.key}`;

    const maxAttempts = this.retries ? MAX_RETRIES + 1 : 1;
    let lastError: CliError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new CliError(
            "timeout",
            `request timed out after ${this.timeoutMs}ms`,
            EXIT_TIMEOUT,
            "Retry, or raise --timeout.",
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError(
          "network_error",
          `request failed: ${message}`,
          EXIT_API,
          "Check connectivity and --base-url.",
        );
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts - 1) {
        await sleep(retryDelayMs(attempt, response.headers.get("Retry-After")));
        continue;
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }

      if (response.ok) {
        return { status: response.status, body: parsed };
      }

      const apiError = (parsed as ApiErrorBody)?.error;
      const code = apiError?.code ?? `http_${response.status}`;
      const message = apiError?.message ?? `API request failed with status ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        lastError = new CliError(
          code,
          message,
          EXIT_AUTH,
          "Set CAESAR_API_KEY or run: caesar-search auth login",
        );
      } else {
        const hint =
          code === "insufficient_balance"
            ? "Top up your organization's balance in the Caesar billing page."
            : response.status === 429
              ? "Rate limited. Wait and retry, or lower request volume."
              : undefined;
        lastError = new CliError(code, message, EXIT_API, hint);
      }
      throw lastError;
    }

    throw lastError ?? new CliError("internal_error", "request loop exhausted", EXIT_API);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const { body: responseBody } = await this.request("POST", path, body);
    return responseBody;
  }

  async get(path: string): Promise<unknown> {
    const { body: responseBody } = await this.request("GET", path);
    return responseBody;
  }
}

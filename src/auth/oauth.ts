import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import type { OAuthLoginConfig } from "../config";
import { CliError, EXIT_API, EXIT_AUTH, EXIT_TIMEOUT } from "../output/exit";
import { VERSION } from "../version";

// Browser login (RFC 8252 loopback + PKCE S256) and device login (RFC 8628)
// against the configured OAuth authorization server, followed by one
// exchange at the console API that mints a named, revocable csk_ key. The
// short-lived access token is discarded immediately after the exchange —
// the CLI never stores OAuth tokens and needs no refresh plumbing.

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

export interface MintedKey {
  secret: string;
  name: string;
}

interface ASMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
}

type StatusWriter = (line: string) => void;

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function fetchJSON(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: timeoutSignal(HTTP_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "X-Caesar-Client": `cli/${VERSION}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new CliError("timeout", `request to ${new URL(url).host} timed out`, EXIT_TIMEOUT);
    }
    throw new CliError("network_error", `could not reach ${new URL(url).host}`, EXIT_API);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

// discoverAS reads RFC 8414 authorization-server metadata, falling back to
// the standard WorkOS Connect endpoint layout when the document is absent.
export async function discoverAS(issuer: string): Promise<ASMetadata> {
  const fallback: ASMetadata = {
    authorizationEndpoint: `${issuer}/oauth2/authorize`,
    tokenEndpoint: `${issuer}/oauth2/token`,
    deviceAuthorizationEndpoint: `${issuer}/oauth2/device_authorization`,
  };
  try {
    const { status, body } = await fetchJSON(`${issuer}/.well-known/oauth-authorization-server`);
    if (status !== 200 || typeof body !== "object" || body === null) return fallback;
    const doc = body as Record<string, unknown>;
    const str = (key: string): string | undefined =>
      typeof doc[key] === "string" && (doc[key] as string).length > 0 ? (doc[key] as string) : undefined;
    return {
      authorizationEndpoint: str("authorization_endpoint") ?? fallback.authorizationEndpoint,
      tokenEndpoint: str("token_endpoint") ?? fallback.tokenEndpoint,
      deviceAuthorizationEndpoint:
        str("device_authorization_endpoint") ?? fallback.deviceAuthorizationEndpoint,
    };
  } catch {
    return fallback;
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// openBrowser best-effort launches the system browser; the URL is always
// printed too, so a failed launch never blocks login.
function openBrowser(url: string): void {
  if (process.env.CAESAR_NO_BROWSER === "1") return;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL is the fallback.
  }
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

async function exchangeToken(tokenEndpoint: string, params: Record<string, string>): Promise<TokenResponse> {
  const { body } = await fetchJSON(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return typeof body === "object" && body !== null ? (body as TokenResponse) : {};
}

// browserLogin runs the loopback flow: a localhost callback listener, the
// system browser for login + consent, PKCE-bound code exchange. Returns the
// short-lived access token.
export async function browserLogin(
  config: OAuthLoginConfig,
  status: StatusWriter,
  options: { openBrowser?: boolean } = {},
): Promise<string> {
  const as = await discoverAS(config.issuer);
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(24));

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Give the success page a beat to flush before the listener dies.
      setTimeout(() => server.close(), 100).unref();
      fn();
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const respond = (title: string, detail: string) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
            `<body style="font-family:system-ui;display:grid;place-items:center;height:90vh">` +
            `<div style="text-align:center"><h2>${title}</h2><p>${detail}</p></div>`,
        );
      };
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const authError = url.searchParams.get("error");
      if (authError) {
        respond("Login failed", "You can close this tab and return to the terminal.");
        settle(() =>
          reject(
            new CliError(
              "oauth_denied",
              `authorization failed: ${url.searchParams.get("error_description") ?? authError}`,
              EXIT_AUTH,
            ),
          ),
        );
        return;
      }
      if (!code || returnedState !== state) {
        respond("Login failed", "State mismatch — close this tab and retry in the terminal.");
        settle(() =>
          reject(
            new CliError(
              "oauth_state_mismatch",
              "authorization response did not match this login attempt",
              EXIT_AUTH,
            ),
          ),
        );
        return;
      }
      respond("Logged in to Caesar", "You can close this tab and return to the terminal.");
      settle(async () => {
        try {
          const token = await exchangeToken(as.tokenEndpoint, {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            code_verifier: verifier,
            ...(config.resource ? { resource: config.resource } : {}),
          });
          if (!token.access_token) {
            reject(
              new CliError(
                "oauth_exchange_failed",
                `token exchange failed: ${token.error_description ?? token.error ?? "no access token returned"}`,
                EXIT_AUTH,
              ),
            );
            return;
          }
          resolve(token.access_token);
        } catch (error) {
          reject(error);
        }
      });
    });

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new CliError("oauth_timeout", "timed out waiting for the browser login (5 minutes)", EXIT_TIMEOUT),
        ),
      );
    }, LOGIN_TIMEOUT_MS);
    timer.unref();

    let redirectUri = "";
    server.on("error", (error) => {
      settle(() =>
        reject(
          new CliError(
            "oauth_listener_failed",
            `could not start the localhost callback listener: ${error.message}`,
            EXIT_API,
          ),
        ),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        settle(() =>
          reject(
            new CliError("oauth_listener_failed", "could not determine the callback listener port", EXIT_API),
          ),
        );
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const authorizeUrl = new URL(as.authorizationEndpoint);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", config.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      if (config.resource) authorizeUrl.searchParams.set("resource", config.resource);

      status("Opening your browser to log in to Caesar…");
      status(`If it does not open, visit:\n  ${authorizeUrl.toString()}`);
      if (options.openBrowser !== false) openBrowser(authorizeUrl.toString());
    });
  });
}

// deviceLogin runs the RFC 8628 flow for SSH/containers/headless machines:
// show a short code + URL, approve on any device, poll the token endpoint.
export async function deviceLogin(config: OAuthLoginConfig, status: StatusWriter): Promise<string> {
  const as = await discoverAS(config.issuer);
  if (!as.deviceAuthorizationEndpoint) {
    throw new CliError(
      "oauth_no_device_flow",
      "the authorization server does not support device login",
      EXIT_AUTH,
    );
  }
  const { status: httpStatus, body } = await fetchJSON(as.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      ...(config.resource ? { resource: config.resource } : {}),
    }).toString(),
  });
  const grant = (typeof body === "object" && body !== null ? body : {}) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (httpStatus !== 200 || !grant.device_code || !grant.user_code) {
    throw new CliError(
      "oauth_device_failed",
      "the authorization server rejected the device login request",
      EXIT_AUTH,
    );
  }

  const verifyUrl = grant.verification_uri_complete ?? grant.verification_uri ?? config.issuer;
  status(`To log in, open:\n  ${verifyUrl}`);
  status(`and enter the code: ${grant.user_code}`);

  let intervalSec = grant.interval && grant.interval > 0 ? grant.interval : 5;
  const deadline =
    Date.now() + (grant.expires_in && grant.expires_in > 0 ? grant.expires_in * 1000 : LOGIN_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalSec * 1000));
    const token = await exchangeToken(as.tokenEndpoint, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: grant.device_code,
      client_id: config.clientId,
    });
    if (token.access_token) return token.access_token;
    switch (token.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalSec += 5;
        continue;
      case "access_denied":
        throw new CliError("oauth_denied", "the login request was denied", EXIT_AUTH);
      case "expired_token":
        throw new CliError(
          "oauth_timeout",
          "the device code expired before the login was approved",
          EXIT_TIMEOUT,
        );
      default:
        throw new CliError(
          "oauth_exchange_failed",
          `device token exchange failed: ${token.error_description ?? token.error ?? "unexpected response"}`,
          EXIT_AUTH,
        );
    }
  }
  throw new CliError("oauth_timeout", "timed out waiting for the device login to be approved", EXIT_TIMEOUT);
}

// mintApiKey exchanges a Connect access token for a named, revocable csk_
// key at the console API, then the caller discards the token. The key shows
// up in the console (labelled) and can be revoked there at any time.
export async function mintApiKey(config: OAuthLoginConfig, accessToken: string): Promise<MintedKey> {
  const name = `CLI · ${hostname()} · ${new Date().toISOString().slice(0, 10)}`;
  const { status, body } = await fetchJSON(`${config.consoleUrl}/v1/organization/api-keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, scope: "member" }),
  });
  const payload = (typeof body === "object" && body !== null ? body : {}) as {
    secret?: string;
    error?: string;
  };
  if (status === 401) {
    throw new CliError("oauth_exchange_failed", "the console rejected the login token", EXIT_AUTH);
  }
  if (status === 403) {
    throw new CliError(
      "no_organization",
      "your account has no active organization — finish onboarding in the console first",
      EXIT_AUTH,
    );
  }
  if (status !== 201 || !payload.secret) {
    throw new CliError(
      "key_mint_failed",
      `the console could not create an API key${payload.error ? `: ${payload.error}` : ""} (status ${status})`,
      EXIT_API,
    );
  }
  return { secret: payload.secret, name };
}

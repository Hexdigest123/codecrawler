export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function extractError(body: unknown): { code: string; message: string } {
  if (body && typeof body === "object" && "error" in body) {
    const inner = (body as { error?: unknown }).error;
    if (inner && typeof inner === "object") {
      const code = (inner as { code?: unknown }).code;
      const message = (inner as { message?: unknown }).message;
      return {
        code: typeof code === "string" ? code : "request_failed",
        message: typeof message === "string" ? message : "Request failed.",
      };
    }
  }
  if (typeof body === "string" && body.length > 0) {
    return { code: "request_failed", message: body };
  }
  return { code: "request_failed", message: "Request failed." };
}

export async function api<T>(
  path: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetcher(path, {
    ...init,
    credentials: "include",
    headers,
  });

  const raw = await res.text();
  let body: unknown = null;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  if (!res.ok) {
    const err = extractError(body);
    throw new ApiError(res.status, err.code, err.message);
  }

  return body as T;
}

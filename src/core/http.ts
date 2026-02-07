import * as https from "node:https";
import type { IncomingHttpHeaders } from "node:http";

export interface JsonRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  timeoutMs?: number;
}

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly responseBody: unknown;
  public readonly retryAfterSeconds?: number;

  public constructor(message: string, statusCode: number, responseBody: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface HttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function rawRequest(url: string, options: JsonRequestOptions): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const hasBody = options.body !== undefined || options.rawBody !== undefined;
    const contentTypeHeader = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");

    if (hasBody && !contentTypeHeader) {
      headers["content-type"] = options.rawBody !== undefined ? "application/x-www-form-urlencoded" : "application/json";
    }

    const request = https.request(
      url,
      {
        method: options.method ?? "GET",
        headers,
        timeout: options.timeoutMs ?? 15000
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });

        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Request timed out for ${url}`));
    });

    request.on("error", (error) => reject(error));

    if (options.rawBody !== undefined) {
      request.write(options.rawBody);
    } else if (options.body !== undefined) {
      request.write(JSON.stringify(options.body));
    }

    request.end();
  });
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function requestJson<T>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const response = await rawRequest(url, options);
  const data = parseJson(response.body);

  if (response.statusCode >= 200 && response.statusCode < 300) {
    return data as T;
  }

  const retryAfterHeader = response.headers["retry-after"];
  const retryAfter = typeof retryAfterHeader === "string" ? Number.parseInt(retryAfterHeader, 10) : undefined;

  throw new HttpError(`Request failed with ${response.statusCode} for ${url}`, response.statusCode, data, retryAfter);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  isRetriable: (error: unknown) => boolean
): Promise<T> {
  let attempt = 0;

  while (true) {
    attempt += 1;

    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetriable(error)) {
        throw error;
      }

      const exponential = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 150);
      await new Promise((resolve) => setTimeout(resolve, exponential + jitter));
    }
  }
}

export function isRateLimitedOrServerError(error: unknown): boolean {
  if (!(error instanceof HttpError)) {
    return false;
  }

  return error.statusCode === 429 || error.statusCode >= 500;
}

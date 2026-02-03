"use client";

import { invoke } from "@tauri-apps/api/core";
import { API_BASE_URL } from "@/lib/constants";

type QueryValue = string | number | boolean | null | undefined;

let cachedApiKey: string | null = null;
let apiKeyPromise: Promise<string> | null = null;
let cachedHeaders: Record<string, string> | null = null;

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

const buildIndexerUrl = (
  path: string,
  query?: Record<string, QueryValue>
): string => {
  const baseUrl = normalizeBaseUrl(API_BASE_URL);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${normalizedPath}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
};

const loadIndexerApiKey = async (): Promise<string> => {
  if (cachedApiKey) return cachedApiKey;

  if (!apiKeyPromise) {
    apiKeyPromise = invoke<string>("get_indexer_api_key")
      .then((key) => {
        const trimmed = key.trim();
        if (!trimmed) {
          throw new Error("INDEXER_API_KEY is empty");
        }
        cachedApiKey = trimmed;
        cachedHeaders = {
          Accept: "application/json",
          "X-API-KEY": trimmed,
        };
        return trimmed;
      })
      .finally(() => {
        apiKeyPromise = null;
      });
  }

  return apiKeyPromise;
};

export const getIndexerHeaders = async (): Promise<Record<string, string>> => {
  if (cachedHeaders) return { ...cachedHeaders };
  await loadIndexerApiKey();
  return { ...(cachedHeaders ?? {}) };
};

export const indexerFetch = async (
  path: string,
  init: RequestInit = {},
  query?: Record<string, QueryValue>
): Promise<Response> => {
  const url = buildIndexerUrl(path, query);
  const headers = new Headers(init.headers || {});
  const baseHeaders = await getIndexerHeaders();

  headers.set("Accept", baseHeaders.Accept);
  headers.set("X-API-KEY", baseHeaders["X-API-KEY"]);

  return fetch(url, {
    ...init,
    headers,
  });
};

export async function indexerGet<T>(
  path: string,
  query?: Record<string, QueryValue>,
  init: RequestInit = {}
): Promise<T> {
  const response = await indexerFetch(path, { ...init, method: "GET" }, query);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? ` - ${body}` : "";
    throw new Error(
      `Indexer request failed: ${response.status} ${response.statusText}${detail}`
    );
  }

  return (await response.json()) as T;
}

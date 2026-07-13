import { BrowserApiError, createBrowserRequest } from "./browserRequest";
import type { operations } from "./generated/openapi";

type OpenApiBrowserSession = operations["getAuthSession"]["responses"][200]["content"]["application/json"];

export type BrowserSession = Omit<OpenApiBrowserSession, "role" | "authMethod"> & {
  role: "owner" | "agent";
  expiresAt?: string;
  authMethod?: "session" | "bearer";
};

export async function getBrowserSession(fetchImpl: typeof fetch = fetch): Promise<BrowserSession | null> {
  try {
    return await createBrowserRequest({ fetch: fetchImpl })<BrowserSession>("/api/auth/session");
  } catch (error) {
    if (error instanceof BrowserApiError && error.status === 401) return null;
    throw error;
  }
}

export function createBrowserSession(ownerToken: string, fetchImpl: typeof fetch = fetch): Promise<BrowserSession> {
  const body: operations["createAuthSession"]["requestBody"]["content"]["application/json"] = { ownerToken };
  return createBrowserRequest({ fetch: fetchImpl })<BrowserSession>("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteBrowserSession(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await createBrowserRequest({ fetch: fetchImpl })<void>("/api/auth/session", { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof BrowserApiError) || error.status !== 401) throw error;
  }
}

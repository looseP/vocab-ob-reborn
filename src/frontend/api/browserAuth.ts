export type BrowserSession = {
  authenticated: true;
  actorId: string;
  role: "owner" | "agent";
  expiresAt?: string;
  authMethod?: "session" | "bearer";
};

function csrfTokenFromCookie(): string | undefined {
  const prefix = "vocab_csrf=";
  const entry = document.cookie.split("; ").find((item) => item.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : undefined;
}

export function browserCsrfHeaders(method = "GET"): Record<string, string> {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return {};
  const csrfToken = csrfTokenFromCookie();
  return csrfToken ? { "X-CSRF-Token": csrfToken } : {};
}

export async function getBrowserSession(fetchImpl: typeof fetch = fetch): Promise<BrowserSession | null> {
  const response = await fetchImpl("/api/auth/session", { credentials: "same-origin" });
  return response.ok ? response.json() as Promise<BrowserSession> : null;
}

export async function createBrowserSession(ownerToken: string, fetchImpl: typeof fetch = fetch): Promise<BrowserSession> {
  const response = await fetchImpl("/api/auth/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Requested-With": "VocabObservatory" },
    body: JSON.stringify({ ownerToken }),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & Partial<BrowserSession>;
  if (!response.ok) throw new Error(payload.error ?? "Login failed");
  return payload as BrowserSession;
}

export async function deleteBrowserSession(fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl("/api/auth/session", {
    method: "DELETE",
    credentials: "same-origin",
    headers: browserCsrfHeaders("DELETE"),
  });
  if (!response.ok && response.status !== 401) throw new Error("Logout failed");
}

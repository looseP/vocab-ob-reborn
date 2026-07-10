import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const baseUrl = process.env.E2E_BASE_URL;
const ownerToken = process.env.E2E_OWNER_TOKEN;
if (!baseUrl || !ownerToken) {
  throw new Error("E2E_BASE_URL and E2E_OWNER_TOKEN are required");
}

function cookieValue(setCookies: string[], name: string): string {
  const prefix = `${name}=`;
  const match = setCookies.find((cookie) => cookie.startsWith(prefix));
  if (!match) throw new Error(`Missing Set-Cookie for ${name}`);
  return match.slice(prefix.length).split(";", 1)[0] as string;
}

const health = await fetch(`${baseUrl}/health`);
if (!health.ok) throw new Error(`Health check failed: ${health.status}`);

const anonymous = await fetch(`${baseUrl}/api/l3/proposals`);
if (anonymous.status !== 401 || !anonymous.headers.get("WWW-Authenticate")?.includes("Bearer")) {
  throw new Error(`Anonymous API request was not rejected as 401: ${anonymous.status}`);
}

const login = await fetch(`${baseUrl}/api/auth/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: baseUrl, "X-Requested-With": "VocabObservatory" },
  body: JSON.stringify({ ownerToken }),
});
if (login.status !== 201) throw new Error(`Session exchange failed: ${login.status} ${await login.text()}`);
const setCookies = login.headers.getSetCookie();
const sessionToken = cookieValue(setCookies, "vocab_session");
const csrfToken = cookieValue(setCookies, "vocab_csrf");
const cookie = `vocab_session=${sessionToken}; vocab_csrf=${csrfToken}`;
if (!setCookies.find((value) => value.startsWith("vocab_session="))?.includes("HttpOnly")) {
  throw new Error("Session cookie is not HttpOnly");
}
if (setCookies.join("\n").includes(ownerToken)) throw new Error("Owner token leaked into cookies");

const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie } });
if (!session.ok) throw new Error(`Cookie session was not accepted: ${session.status}`);

const csrfRejected = await fetch(`${baseUrl}/api/l3/proposals`, {
  method: "POST",
  headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" },
  body: "{}",
});
if (csrfRejected.status !== 403) throw new Error(`Missing CSRF token was not rejected: ${csrfRejected.status}`);

const crossSiteRejected = await fetch(`${baseUrl}/api/l3/proposals`, {
  method: "POST",
  headers: { Cookie: cookie, Origin: "https://evil.example", "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
  body: "{}",
});
if (crossSiteRejected.status !== 403) throw new Error(`Cross-site Origin was not rejected: ${crossSiteRejected.status}`);

const logout = await fetch(`${baseUrl}/api/auth/session`, {
  method: "DELETE",
  headers: { Cookie: cookie, Origin: baseUrl, "X-CSRF-Token": csrfToken },
});
if (logout.status !== 204) throw new Error(`Logout failed: ${logout.status}`);
const afterLogout = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie } });
if (afterLogout.status !== 401) throw new Error(`Revoked session was still accepted: ${afterLogout.status}`);

const frontendRoot = join(process.cwd(), "dist", "frontend");
const artifactPaths: string[] = [];
async function collectArtifacts(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectArtifacts(path);
    else artifactPaths.push(path);
  }
}
await collectArtifacts(frontendRoot);
const forbiddenValues = [
  ownerToken,
  process.env.DATABASE_URL,
  process.env.LLM_API_KEY,
  process.env.OWNER_API_TOKEN,
].filter((value): value is string => Boolean(value));
for (const artifactPath of artifactPaths) {
  const content = await readFile(artifactPath);
  const text = content.toString("utf8");
  for (const secret of forbiddenValues) {
    if (text.includes(secret)) throw new Error(`Sensitive value leaked into frontend artifact: ${artifactPath}`);
  }
  if (/VITE_OWNER_API_TOKEN|postgres(?:ql)?:\/\//i.test(text)) {
    throw new Error(`Sensitive configuration marker leaked into frontend artifact: ${artifactPath}`);
  }
}

console.log("Browser auth E2E passed");
console.log("Anonymous 401, HttpOnly session, CSRF/Origin rejection, logout revocation, and bundle secret scan passed");

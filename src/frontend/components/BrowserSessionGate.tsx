import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  createBrowserSession,
  deleteBrowserSession,
  getBrowserSession,
  type BrowserSession,
} from "../api/browserAuth";

export function BrowserSessionGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BrowserSession | null | undefined>(undefined);
  const [ownerToken, setOwnerToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getBrowserSession().then(setSession).catch(() => setSession(null));
  }, []);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await createBrowserSession(ownerToken));
      setOwnerToken("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  if (session === undefined) {
    return <main className="auth-gate"><p>Checking secure session...</p></main>;
  }

  if (!session) {
    return (
      <main className="auth-gate">
        <form className="auth-card" onSubmit={login}>
          <p className="eyebrow">Secure browser session</p>
          <h1>Vocab Observatory</h1>
          <p>The owner token is exchanged directly with the server and is never persisted in browser storage or bundled into frontend assets.</p>
          <label htmlFor="owner-token">Owner access token</label>
          <input
            id="owner-token"
            name="owner-token"
            type="password"
            autoComplete="current-password"
            value={ownerToken}
            onChange={(event) => setOwnerToken(event.target.value)}
            required
          />
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <button type="submit" disabled={busy}>{busy ? "Signing in..." : "Create secure session"}</button>
        </form>
      </main>
    );
  }

  return (
    <>
      <div className="session-toolbar">
        <span>Signed in as {session.role}</span>
        <button type="button" onClick={() => void deleteBrowserSession().then(() => setSession(null))}>Sign out</button>
      </div>
      {children}
    </>
  );
}

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Lock, LogOut, Eye, EyeOff } from "lucide-react";
import {
  createBrowserSession,
  deleteBrowserSession,
  getBrowserSession,
  type BrowserSession,
} from "../api/browserAuth";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Spinner } from "./ui/Spinner";

export function BrowserSessionGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BrowserSession | null | undefined>(undefined);
  const [ownerToken, setOwnerToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);

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
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-body)]">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (!session) {
    return (
      <div
        className="flex min-h-screen items-center justify-center px-4"
        style={{
          background:
            "var(--bg-body), var(--bg-body-radial-1), var(--bg-body-radial-2)",
        }}
      >
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <div className="soft-grid mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface-glass)]">
              <span className="section-title text-2xl font-bold text-[var(--color-accent)]">
                词
              </span>
            </div>
            <h1 className="section-title text-3xl font-bold text-[var(--color-ink)]">
              Vocab Observatory
            </h1>
            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
              安全浏览器会话
            </p>
          </div>

          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-8 shadow-[var(--shadow-panel)] backdrop-blur-xl">
            <div className="mb-6 flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
              <Lock className="h-4 w-4" />
              <span>Owner token 直接与服务器交换，不持久化在浏览器中</span>
            </div>

            <form onSubmit={login} className="space-y-4">
              <div>
                <label
                  htmlFor="owner-token"
                  className="mb-2 block text-sm font-medium text-[var(--color-ink)]"
                >
                  Owner Access Token
                </label>
                <div className="relative">
                  <Input
                    id="owner-token"
                    name="owner-token"
                    type={showToken ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="输入 owner token..."
                    value={ownerToken}
                    onChange={(e) => setOwnerToken(e.target.value)}
                    required
                    className="w-full pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                  >
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <p
                  className="rounded-lg border border-[var(--color-rating-again-border)] bg-[var(--color-rating-again-bg)] px-4 py-2 text-sm text-[var(--color-accent-2)]"
                  role="alert"
                >
                  {error}
                </p>
              )}

              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={busy || !ownerToken}
              >
                {busy ? "正在创建会话..." : "创建安全会话"}
              </Button>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-[var(--color-ink-soft)]">
            Vocab Observatory · Obsidian 主库 / Web 复习前台
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-panel-strong)] px-4 py-2 text-xs text-[var(--color-ink-soft)] shadow-[var(--shadow-panel)] backdrop-blur-xl">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" />
          {session.role}
        </span>
        <button
          type="button"
          onClick={() => void deleteBrowserSession().then(() => setSession(null))}
          className="flex items-center gap-1 text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-accent-2)]"
        >
          <LogOut className="h-3 w-3" />
          退出
        </button>
      </div>
      {children}
    </>
  );
}

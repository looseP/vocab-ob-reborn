/**
 * 升级工作台页（ADR-0018，T10）：待升级清单 + 工单工作台。
 *
 * - 待升级清单：进行中工单（标记中 + 升级中），列 词面 / 词书 / 方向 /
 *   档位徽标 / 快照时间；行内 start / cancel / complete。
 * - 工作台：升级中的工单展开 WordL2Composer（direction 从工单注入并锁定）。
 *   内容保存（onConfirmed）即调用 POST :id/complete 完成升级（幂等，
 *   alreadyPromoted 视为成功）。
 * - 词书：非 L3 前端没有词书选择器，取 GET /api/wordbooks/default（一次
 *   取用 + 模块级缓存）。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Library, Wrench } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { useToast } from "@/frontend/components/ui/Toast";
import { WordL2Composer } from "@/frontend/components/words/WordL2Composer";
import { apiFetch } from "@/frontend/api/client";
import { getDefaultWordbook } from "@/frontend/api/wordbooks";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import type { Direction } from "@/domain";

type SuggestionLevel = "strong" | "normal" | "needs_settling";

interface UpgradeWorkItem {
  id: string;
  word_id: string;
  direction: Direction;
  status: string;
  suggestion_snapshot: { level?: unknown; capturedAt?: unknown } | null;
  created_at: string;
  word: { slug: string | null; text: string | null };
  suggestion: SuggestionLevel;
}

const SUGGESTION_LABELS: Record<SuggestionLevel, string> = {
  strong: "强烈推荐升级",
  normal: "推荐升级",
  needs_settling: "需要沉淀",
};

const SUGGESTION_TONES: Record<SuggestionLevel, "accent" | "default" | "warm"> = {
  strong: "accent",
  normal: "default",
  needs_settling: "warm",
};

function errorMessage(err: unknown): string {
  if (err instanceof BrowserApiError) return err.message || `请求失败（${err.status}）`;
  return err instanceof Error ? err.message : "未知错误";
}

/** 快照时间（capturedAt 优先，缺省回落创建时间）。 */
function snapshotTime(item: UpgradeWorkItem): string | null {
  const capturedAt = item.suggestion_snapshot?.capturedAt;
  const value = typeof capturedAt === "string" ? capturedAt : item.created_at;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export function UpgradePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<UpgradeWorkItem[]>([]);
  const [wordbookName, setWordbookName] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openWorkbenchId, setOpenWorkbenchId] = useState<string | null>(null);
  const { addToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const wordbook = await getDefaultWordbook();
      setWordbookName(wordbook.name);
      const data = await apiFetch<{ items: UpgradeWorkItem[] }>(
        `/upgrade-work-orders?wordbookId=${encodeURIComponent(wordbook.id)}`,
      );
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (item: UpgradeWorkItem, action: "start" | "cancel" | "complete") => {
    setBusyId(item.id);
    try {
      await apiFetch(`/upgrade-work-orders/${encodeURIComponent(item.id)}/${action}`, {
        method: "POST",
        timeoutMs: 60_000,
      });
      if (action === "start") {
        setItems((prev) =>
          prev.map((row) => (row.id === item.id ? { ...row, status: "升级中" } : row)),
        );
      } else {
        // cancel / complete 后离开进行中清单。
        setItems((prev) => prev.filter((row) => row.id !== item.id));
        setOpenWorkbenchId((current) => (current === item.id ? null : current));
        addToast("success", action === "complete" ? "升级完成，词已进入 L2 辨析训练" : "已取消该升级工单");
      }
    } catch (err) {
      addToast("error", errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }, [addToast]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">升级工作台</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">
          用户主动提前升级（ADR-0018）：标记 → agent 交互校准内容 → 完成升级。
          {wordbookName ? ` 当前词书：${wordbookName}` : ""}
        </p>
      </div>

      {loading ? (
        <Card className="flex items-center justify-center py-16">
          <Spinner />
          <span className="ml-3 text-[var(--color-ink-soft)]">加载待升级清单...</span>
        </Card>
      ) : error ? (
        <Card>
          <EmptyState
            title="无法加载待升级清单"
            description={error}
            action={<Button onClick={() => void load()}>重试</Button>}
          />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Library className="h-8 w-8 text-[var(--color-accent)]" />}
            title="没有待升级的词"
            description="在复习卡上点「标记升级」，或到词条详情页自助发起；升级意图会出现在这里。"
            action={
              <Link to="/review">
                <Button variant="secondary">去复习</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {items.map((item) => {
            const wordLabel = item.word?.text ?? item.word?.slug ?? item.word_id;
            const time = snapshotTime(item);
            const workbenchOpen = openWorkbenchId === item.id;
            return (
              <div
                key={item.id}
                className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {item.word?.slug ? (
                      <Link
                        to={`/words/${encodeURIComponent(item.word.slug)}`}
                        className="font-mono text-lg font-semibold text-[var(--color-ink)] hover:text-[var(--color-accent)]"
                      >
                        {wordLabel}
                      </Link>
                    ) : (
                      <span className="font-mono text-lg font-semibold text-[var(--color-ink)]">{wordLabel}</span>
                    )}
                    <Badge>{item.direction}</Badge>
                    <Badge tone={SUGGESTION_TONES[item.suggestion] ?? "default"}>
                      {SUGGESTION_LABELS[item.suggestion] ?? item.suggestion}
                    </Badge>
                    {time && <span className="text-xs text-[var(--color-ink-soft)]">快照 {time}</span>}
                    <Badge tone={item.status === "升级中" ? "accent" : "default"}>{item.status}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {item.status === "标记中" && (
                      <Button size="sm" disabled={busyId !== null} onClick={() => void act(item, "start")}>
                        {busyId === item.id ? <Spinner /> : null}
                        开始升级
                      </Button>
                    )}
                    {item.status === "升级中" && (
                      <>
                        <Button
                          size="sm"
                          variant={workbenchOpen ? "secondary" : "primary"}
                          disabled={busyId !== null}
                          onClick={() => setOpenWorkbenchId(workbenchOpen ? null : item.id)}
                        >
                          <Wrench className="h-4 w-4" />
                          {workbenchOpen ? "收起工作台" : "打开工作台"}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyId !== null}
                          onClick={() => void act(item, "complete")}
                        >
                          {busyId === item.id ? <Spinner /> : null}
                          完成升级
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId !== null}
                      onClick={() => void act(item, "cancel")}
                    >
                      取消
                    </Button>
                  </div>
                </div>
                {workbenchOpen && (item.status === "升级中") && (
                  item.word?.slug ? (
                    <WordL2Composer
                      slug={item.word.slug}
                      direction={item.direction}
                      directionLocked
                      onConfirmed={() => void act(item, "complete")}
                    />
                  ) : (
                    <p className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-4 text-sm text-[var(--color-ink-soft)]">
                      该词缺少 slug，无法打开内容工作台。
                    </p>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

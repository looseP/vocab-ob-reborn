/**
 * 复习队列全景（P1，2026-10-10）。
 *
 * 补上此前完全缺失的一块：**没有任何入口能看到「我的队列里到底有哪些词」**。
 * 之前只能看到数字（仪表盘今日待复习、集合页已追踪数），或按天点开复习日历的
 * 未来侧某一格 —— 想确认「我到底在背哪些词、哪些积压了、哪些被我挂起了」无从下手。
 *
 * 本页给出四件事：
 *  1. **总量**：现在就该复习（= 学习中 + 到期）、新卡、已挂起，各多少张；
 *  2. **清单**：按互斥桶（到期/学习中/已掌握/新卡/已挂起）分页浏览 + 搜索；
 *  3. **处置**：行内「提前到期」（插队进池）与「移出队列」（删进度行），
 *     复用 P1 队列编辑端点 —— 于是「看得见」与「管得了」在同一屏闭环；
 *  4. **今日到期**（2026-10-12，时间 facet）：仪表盘「今日共 N 张到期」那个数的
 *     **清单**。分桶按 state 切，看不见「今天稍后到点」的卡（一张 review 态、今天
 *     15:43 到点的卡在 due 桶里看不到，在已掌握桶里又和 11-29 的混在一起）——
 *     本视图 = bucket=all + dueWindow=today，深链 `/review-queue?dueWindow=today`。
 *
 * 口径说明（别与其他数字混用）：
 *  - 「现在就该复习」= 非挂起、非新卡、且已到期；**不含新卡**（新卡按每日配额引入）。
 *  - 与仪表盘那张卡**同源但不同数**（2026-10-12 对齐）：卡上的大数字就是本页「到期」
 *    桶的口径（此刻已到期）；它下面的副标题「今日共 N 张到期」才是上海日历日口径
 *    （含今天稍后到点的卡）—— 那些卡按状态落在「学习中」「已掌握」桶里，因清单按
 *    到期时间排序，各自排在最前。
 *
 * 清单默认**只出词形、不出中文释义**（2026-10-12）：进这一页多半是「复习前先看一眼
 * 攒了哪些词」，此时把释义摆在眼前等于提前把答案看了。要看释义得显式按「显示释义」
 * —— 与自动伴读 ③b 同一口径：**防线是默认值，不是硬过滤**。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CalendarClock, Layers, Repeat, Search, Trash2 } from "lucide-react";
import { Badge } from "@/frontend/components/ui/Badge";
import { Button } from "@/frontend/components/ui/Button";
import { Card } from "@/frontend/components/ui/Card";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { Input } from "@/frontend/components/ui/Input";
import { Modal } from "@/frontend/components/ui/Modal";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { useReviewQueue } from "@/frontend/hooks/useReviewQueue";
import type {
  ReviewQueueBucket,
  ReviewQueueCounts,
  ReviewQueueDueWindow,
  ReviewQueueListItem,
} from "@/frontend/api/reviewQueue";

/** 桶 → tab 文案。顺序即展示顺序：到期优先，最后是「全部」。 */
const BUCKET_TABS: ReadonlyArray<{ id: ReviewQueueBucket; label: string }> = [
  { id: "due", label: "到期" },
  { id: "learning", label: "学习中" },
  { id: "new", label: "新卡" },
  { id: "review", label: "已掌握" },
  { id: "suspended", label: "已挂起" },
  { id: "all", label: "全部" },
];

const STATE_LABELS: Record<ReviewQueueListItem["state"], string> = {
  new: "新词",
  learning: "学习中",
  relearning: "重学",
  review: "已掌握",
  suspended: "已挂起",
};

/**
 * 到期标签 —— 「距到期」语义（与各页面的「距上次复习」相对时间不是一回事，故不复用）。
 * 纯函数导出便于单测。
 */
export function formatDueLabel(dueAt: string | null, now: Date = new Date()): string {
  if (!dueAt) return "未安排";
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return "未安排";
  const diffMs = due.getTime() - now.getTime();
  if (diffMs <= 0) return "已到期";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin} 分钟后`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时后`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天后`;
  return due.toLocaleDateString("zh-CN");
}

/** 桶 tab 上的徽标数字；`all` 用总数，`dueNow`（现在就该复习）单列在汇总卡。 */
export function bucketTabCount(bucket: ReviewQueueBucket, counts: ReviewQueueCounts | null): number {
  if (!counts) return 0;
  switch (bucket) {
    case "due":
      return counts.due;
    case "learning":
      return counts.learning;
    case "new":
      return counts.new;
    case "review":
      return counts.review;
    case "suspended":
      return counts.suspended;
    case "all":
      return counts.total;
  }
}

/** tab 按钮样式：激活态用强调色边框（与页面其他 chip 一致）。 */
function tabClass(active: boolean): string {
  return active
    ? "rounded-full border border-[var(--color-accent)] bg-[var(--color-surface-muted)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent)]"
    : "rounded-full border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]";
}

/** 空态文案：区分「桶本身空」「facet 空」与「搜索后空」—— 后者要给回到全部的出路。 */
export function emptyHint(
  bucket: ReviewQueueBucket,
  searching: boolean,
  dueWindow: ReviewQueueDueWindow | null = null,
): string {
  if (searching) return "没有匹配的词，换个关键词或清空搜索试试。";
  if (dueWindow === "today") return "今天没有到期的卡。";
  switch (bucket) {
    case "due":
      // 不说「今天到此为止」：今天稍后到点的卡不在此桶（按状态落在「学习中」「已掌握」，
      // 因清单按到期时间排序而各自排在最前）—— 那句话会当着用户的面撒谎。
      return "当前没有已到期的复习卡。";
    case "learning":
      return "没有处于学习期的卡。";
    case "new":
      return "没有待学的新卡。可以从词条库或广场把词加进复习队列。";
    case "review":
      return "没有已到期之外的成熟卡。";
    case "suspended":
      return "没有被挂起的词（挂起 = 你手动标记的「不想再看到」）。";
    case "all":
      return "复习队列是空的。";
  }
}

export function ReviewQueuePage() {
  const queue = useReviewQueue();
  const [pendingRemoval, setPendingRemoval] = useState<ReviewQueueListItem | null>(null);
  /** 中文释义默认收起（见文件头：复习前先看一眼，别提前把答案摆出来）。 */
  const [showDefinition, setShowDefinition] = useState(false);

  const searching = queue.searchInput.trim().length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">复习队列</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            队列里到底有哪些词 —— 按状态分桶浏览，并可直接处置
          </p>
        </div>
        <Link
          to="/review"
          className="inline-flex items-center gap-2 text-sm text-[var(--color-accent)] hover:underline"
        >
          <Repeat className="h-4 w-4" />
          去复习
        </Link>
      </div>

      {/* ① 总量：三个决定行动的数字（不是「队列总数」那种不可行动的数） */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryTile
          icon={<CalendarClock className="h-5 w-5" />}
          label="现在就该复习"
          value={queue.counts?.dueNow ?? null}
          hint="已到期且未挂起、非新卡（= 学习中 + 到期）。与仪表盘行动区的大数字同口径（2026-10-12 起那边也用这个数）；「今天稍后到点」的卡不在此列 —— 它们在「学习中」「已掌握」桶里，按到期时间排最前。"
        />
        <SummaryTile
          icon={<Layers className="h-5 w-5" />}
          label="待学新卡"
          value={queue.counts?.new ?? null}
          hint="已加入队列但还没开始学的词。它们按每日新卡配额逐批引入，不会一次全砸给你。"
        />
        <SummaryTile
          icon={<AlertTriangle className="h-5 w-5" />}
          label="已挂起"
          value={queue.counts?.suspended ?? null}
          hint="你手动标记「不想再看到」的词：不参与到期判定，也不会出现在复习批次里。"
        />
      </div>

      {/* ② 分桶 tab + 搜索 */}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {BUCKET_TABS.map((tab) => {
            // facet 视图下没有任何状态桶是激活的（二者互斥，见 hook）
            const active = queue.bucket === tab.id && queue.dueWindow === null;
            const count = bucketTabCount(tab.id, queue.counts);
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => queue.setBucket(tab.id)}
                aria-pressed={active}
                className={tabClass(active)}
              >
                {tab.label}
                <span className="ml-1.5 text-xs opacity-70">{count}</span>
              </button>
            );
          })}
          {/*
            「今日到期」是**时间 facet**（与状态桶正交、刻意重叠），故不塞进 BUCKET_TABS：
            点它 ⇒ bucket=all + dueWindow=today；点任一状态桶 ⇒ 自动清掉它（hook 里做）。
            它补的正是仪表盘「今日共 N 张到期」的**清单**缺口 —— 那个数此前点进去只能
            看到「到期 0」，用户以为调度坏了（2026-10-12 实测）。
          */}
          <button
            type="button"
            onClick={() => queue.setDueWindow(queue.dueWindow === "today" ? null : "today")}
            aria-pressed={queue.dueWindow === "today"}
            className={tabClass(queue.dueWindow === "today")}
            title="今天（上海日历日）内到期的全部卡：含此刻已到期的，也含今天稍后到点的；不管它处于哪个状态桶。"
          >
            今日到期
            <span className="ml-1.5 text-xs opacity-70">{queue.counts?.dueToday ?? 0}</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-soft)]" />
            <Input
              value={queue.searchInput}
              onChange={(e) => queue.setSearchInput(e.target.value)}
              placeholder="搜索词条（lemma 或标题）"
              className="pl-9"
              aria-label="搜索队列中的词条"
            />
          </div>
          <span className="text-xs text-[var(--color-ink-soft)]">
            {searching
              ? `匹配 ${queue.total} 张`
              : `共 ${queue.total} 张${queue.items.length < queue.total ? `（已加载 ${queue.items.length}）` : ""}`}
          </span>
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={showDefinition}
            onClick={() => setShowDefinition((prev) => !prev)}
            title="默认只出词形：这里多半是「复习前先看一眼」，先看见中文释义等于提前把答案看了。"
          >
            {showDefinition ? "隐藏释义" : "显示释义"}
          </Button>
        </div>
      </Card>

      {/* ③ 清单 */}
      {queue.error && !queue.loading && (
        <Card>
          <EmptyState title="队列加载失败" description={queue.error} />
        </Card>
      )}

      {queue.loading && queue.items.length === 0 && (
        <Card className="flex items-center justify-center gap-3 py-10 text-sm text-[var(--color-ink-soft)]">
          <Spinner className="h-4 w-4" />
          正在加载队列…
        </Card>
      )}

      {!queue.loading && queue.items.length === 0 && !queue.error && (
        <Card>
          <EmptyState
            title="这里是空的"
            description={emptyHint(queue.bucket, searching, queue.dueWindow)}
            action={
              searching ? (
                <Button variant="secondary" onClick={() => queue.setSearchInput("")}>
                  清空搜索
                </Button>
              ) : undefined
            }
          />
        </Card>
      )}

      {queue.items.length > 0 && (
        <div className="space-y-2">
          {queue.items.map((item) => (
            <QueueRow
              key={item.wordId}
              item={item}
              busy={queue.pendingWordId === item.wordId}
              showDefinition={showDefinition}
              onExpire={() => void queue.expireOne(item.wordId)}
              onRemove={() => setPendingRemoval(item)}
            />
          ))}

          {queue.hasMore && (
            <div className="flex justify-center pt-2">
              <Button variant="secondary" onClick={queue.loadMore} disabled={queue.loadingMore}>
                {queue.loadingMore ? "加载中…" : `加载更多（还有 ${Math.max(0, queue.total - queue.items.length)} 张）`}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 移出队列是破坏性的（删进度行 ⇒ FSRS 记忆强度归零），必须二次确认 */}
      <Modal
        open={pendingRemoval !== null}
        onClose={() => setPendingRemoval(null)}
        title="移出复习队列"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingRemoval(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = pendingRemoval;
                setPendingRemoval(null);
                if (target) void queue.removeOne(target.wordId);
              }}
            >
              确认移出
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--color-ink-soft)]">
          将 <span className="font-semibold text-[var(--color-ink)]">{pendingRemoval?.lemma}</span>{" "}
          移出复习队列？
        </p>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          会删除这个词的学习进度（复习次数、间隔、记忆强度）。词条本身不会删除；之后重新加入复习队列时，FSRS
          会从头开始排间隔。
        </p>
      </Modal>
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  hint: string;
}) {
  return (
    <Card title={hint} className="flex items-center gap-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--color-surface-muted)] text-[var(--color-accent)]">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm text-[var(--color-ink-soft)]">{label}</div>
        <div className="text-xl font-bold text-[var(--color-ink)]">
          {value === null ? "—" : value}
        </div>
      </div>
    </Card>
  );
}

function QueueRow({
  item,
  busy,
  showDefinition,
  onExpire,
  onRemove,
}: {
  item: ReviewQueueListItem;
  busy: boolean;
  /** 中文释义是否上屏（默认 false，见页面文件头）。 */
  showDefinition: boolean;
  onExpire: () => void;
  onRemove: () => void;
}) {
  // 挂起的词不参与到期判定，「提前到期」对它无意义 ⇒ 不给这个按钮（后端也会忽略）。
  const canExpire = item.state !== "suspended";

  return (
    <Card className="flex flex-wrap items-center gap-3 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/words/${item.slug}`}
            className="truncate font-semibold text-[var(--color-ink)] hover:text-[var(--color-accent)] hover:underline"
          >
            {item.lemma}
          </Link>
          {item.cefr && <Badge>{item.cefr}</Badge>}
          {item.pos && <Badge>{item.pos}</Badge>}
          <Badge tone={item.state === "suspended" ? "warm" : "default"}>
            {STATE_LABELS[item.state]}
          </Badge>
          {item.needsRecheck && <Badge tone="accent">内容已更新</Badge>}
        </div>
        {showDefinition && item.shortDefinition && (
          <p className="mt-1 truncate text-sm text-[var(--color-ink-soft)]">{item.shortDefinition}</p>
        )}
        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
          {formatDueLabel(item.dueAt)} · 复习 {item.reviewCount} 次
          {item.lapseCount > 0 ? ` · 遗忘 ${item.lapseCount} 次` : ""}
          {item.stability !== null ? ` · 记忆强度 ${Math.round(item.stability)} 天` : ""}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {canExpire && (
          <Button variant="ghost" size="sm" onClick={onExpire} disabled={busy} title="把到期时间提到现在：立刻插队进复习批次">
            <CalendarClock className="h-4 w-4" />
            提前到期
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy} title="从队列移除（删除学习进度，词条保留）">
          <Trash2 className="h-4 w-4" />
          移出
        </Button>
        {busy && <Spinner className="h-4 w-4" />}
      </div>
    </Card>
  );
}

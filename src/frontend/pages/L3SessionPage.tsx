/**
 * L3 会话壳（ADR-0019 §2）：创建攻坚包 → 现拉现渲染 plan 引用 → 结束。
 *
 * - 创建：POST /api/l3-sessions（space×direction×N×D）；
 * - 渲染：GET /api/l3-sessions/:id 的渲染描述（plan 只存 id 引用，每次现拉现
 *   渲染；**不把渲染结果落库**）；
 * - 边界（ADR-0019/0028）：
 *   ① 引用实体已被删除 → 当天分组内渲染「已删除」占位，不得白屏；
 *   ② 服务层对未知 plan version 抛 422 BUSINESS_RULE → 提示「会话计划版本已
 *      过期，请重建」，不得静默；
 *   ③ 本页只消费 attempts 无关的会话数据；练习记录归练习台。
 */
import { useState } from "react";
import type { Direction, L3SessionRenderDescription, L3SubSpace } from "@/domain";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import { L3NavigationActions } from "../components/L3NavigationActions";
import {
  isNormalizedL3Error,
  L3_DIRECTION_VALUES,
  L3_SUB_SPACE_VALUES,
  normalizeL3TransportError,
  type L3FrontendClient,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import { navigationAction, type L3NavigationIntent } from "../viewModels/l3NavigationViewModel";
import {
  buildSessionDayGroups,
  isSessionPlanVersionError,
  SESSION_PLAN_VERSION_EXPIRED_COPY,
  sessionDisplayTitle,
  SESSION_STATUS_LABELS,
  SESSION_TYPE_LABELS,
} from "../viewModels/l3SessionViewModel";

interface L3SessionPageProps {
  client: L3FrontendClient;
  onNavigate(intent: L3NavigationIntent): void;
}

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

/** 表单正整数解析：空 → null（走服务端默认值）；非法 → 抛错给本地提示。 */
function parseOptionalPositiveInt(raw: string, label: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
  return value;
}

export function L3SessionPage({ client, onNavigate }: L3SessionPageProps) {
  const [space, setSpace] = useState<L3SubSpace | null>(null);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [contextCount, setContextCount] = useState("20");
  const [days, setDays] = useState("7");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [ending, setEnding] = useState(false);
  const [formNote, setFormNote] = useState<string | null>(null);
  const [createError, setCreateError] = useState<NormalizedL3Error | null>(null);
  const [loadError, setLoadError] = useState<NormalizedL3Error | null>(null);
  const [endError, setEndError] = useState<NormalizedL3Error | null>(null);
  const [session, setSession] = useState<L3SessionRenderDescription | null>(null);

  const loadSession = async (id: string) => {
    setLoadingSession(true);
    setLoadError(null);
    try {
      const rendered = await client.getSession(id);
      setSession(rendered);
    } catch (caught) {
      setLoadError(normalizeUnknownError(caught));
    } finally {
      setLoadingSession(false);
    }
  };

  const create = async () => {
    setFormNote(null);
    setCreateError(null);
    setLoadError(null);
    setEndError(null);
    let countValue: number | null;
    let daysValue: number | null;
    try {
      countValue = parseOptionalPositiveInt(contextCount, "题量");
      daysValue = parseOptionalPositiveInt(days, "天数");
    } catch (caught) {
      setFormNote(caught instanceof Error ? caught.message : "输入不合法。");
      return;
    }
    setCreating(true);
    try {
      const row = await client.createSession({
        type: "cram_pack",
        title: title.trim() || null,
        space,
        direction,
        contextCount: countValue,
        days: daysValue,
      });
      await loadSession(row.id);
    } catch (caught) {
      setCreateError(normalizeUnknownError(caught));
    } finally {
      setCreating(false);
    }
  };

  const end = async (status: "completed" | "abandoned") => {
    if (!session || ending) return;
    if (status === "abandoned" && !window.confirm("放弃该会话？已记录的练习不受影响，之后可重建会话。")) return;
    setEnding(true);
    setEndError(null);
    try {
      const updated = await client.endSession(session.session.id, status);
      setSession({ ...session, session: updated });
    } catch (caught) {
      setEndError(normalizeUnknownError(caught));
    } finally {
      setEnding(false);
    }
  };

  const groups = session ? buildSessionDayGroups(session) : [];
  const busy = creating || loadingSession || ending;

  return (
    <section className="l3-page space-y-4">
      <p className="eyebrow">L3 Session</p>
      <h2>会话：攻坚包（时间盒计划，有反复、无排程）</h2>
      <p className="lede">
        按子空间 × 方向抽取语境素材组成按天计划。会话只保存实体引用，每次打开现拉现渲染，素材更新与删除会即时反映。
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          子空间
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={busy}
            onChange={(event) => setSpace((event.target.value || null) as L3SubSpace | null)}
            value={space ?? ""}
          >
            <option value="">全部</option>
            {L3_SUB_SPACE_VALUES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          方向
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={busy}
            onChange={(event) => setDirection((event.target.value || null) as Direction | null)}
            value={direction ?? ""}
          >
            <option value="">全部</option>
            {L3_DIRECTION_VALUES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          题量
          <input
            className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={busy}
            min={1}
            onChange={(event) => setContextCount(event.target.value)}
            type="number"
            value={contextCount}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          天数
          <input
            className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={busy}
            min={1}
            onChange={(event) => setDays(event.target.value)}
            type="number"
            value={days}
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          标题（可选）
          <input
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：考前两周阅读攻坚"
            value={title}
          />
        </label>
        <button
          className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50"
          disabled={busy}
          onClick={() => void create()}
          type="button"
        >
          {creating ? "创建中…" : "创建攻坚包"}
        </button>
      </div>

      {formNote && <p className="text-sm text-[var(--color-ink-soft)]">{formNote}</p>}
      <L3ErrorMessage error={createError} />

      {isSessionPlanVersionError(loadError) ? (
        <div className="space-y-2 rounded-lg border border-[var(--color-border)] px-4 py-3">
          <strong className="text-[13px]">{SESSION_PLAN_VERSION_EXPIRED_COPY}</strong>
          <p className="text-[11px] text-[var(--color-ink-soft)]">{loadError?.message}</p>
          <button
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs"
            onClick={() => { setSession(null); setLoadError(null); }}
            type="button"
          >
            重建会话
          </button>
        </div>
      ) : (
        <L3ErrorMessage error={loadError} />
      )}

      {session && (
        <div className="space-y-3 rounded-lg border border-[var(--color-border)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="eyebrow">{SESSION_TYPE_LABELS[session.session.type]}</p>
              <h3 className="text-[15px]">{sessionDisplayTitle(session.session.title)}</h3>
              <p className="text-[11px] text-[var(--color-ink-soft)]">
                状态：{SESSION_STATUS_LABELS[session.session.status]} · 创建于 {session.session.created_at}
                {session.session.ended_at ? ` · 结束于 ${session.session.ended_at}` : ""}
              </p>
            </div>
            <button
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs disabled:opacity-50"
              disabled={busy}
              onClick={() => void loadSession(session.session.id)}
              type="button"
            >
              {loadingSession ? "刷新中…" : "刷新渲染"}
            </button>
            <button
              className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50"
              disabled={busy || session.session.status !== "active"}
              onClick={() => void end("completed")}
              type="button"
            >
              完成
            </button>
            <button
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-soft)] disabled:opacity-50"
              disabled={busy || session.session.status !== "active"}
              onClick={() => void end("abandoned")}
              type="button"
            >
              放弃
            </button>
          </div>

          <L3ErrorMessage error={endError} />

          {groups.length === 0 && (
            <p className="text-[12px] text-[var(--color-ink-soft)]">该会话没有可渲染的语境引用。</p>
          )}

          {groups.map((group) => (
            <div className="space-y-2" key={group.day}>
              <p className="text-[12px] font-medium">第 {group.day} 天</p>
              <ul className="space-y-2">
                {group.contexts.map((context) => (
                  <li className="space-y-1 rounded-lg border border-[var(--color-border)] px-3 py-2" key={context.id}>
                    <p className="text-[13px] leading-relaxed">{context.text}</p>
                    <p className="text-[11px] text-[var(--color-ink-soft)]">—— {context.source_title}</p>
                    <L3NavigationActions
                      actions={[navigationAction("查看语境", { target: "context", contextId: context.id })]}
                      onNavigate={onNavigate}
                    />
                  </li>
                ))}
                {group.deletedContextIds.map((id) => (
                  <li className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2" key={`deleted-${id}`}>
                    <p className="text-[12px] text-[var(--color-ink-soft)]">
                      已删除：该引用素材（{id.slice(0, 8)}…）已被清理，不再可渲染。
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

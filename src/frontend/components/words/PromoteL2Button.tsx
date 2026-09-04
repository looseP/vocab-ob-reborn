import { useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";

interface PromoteL2ButtonProps {
  slug: string;
  promoted: boolean;
  /** 晋升成功后回调（详情页刷新缓存 → 徽标/待扩展提示即时出现）。 */
  onPromoted: () => void;
}

/**
 * Phase F 主动晋升入口：跳过 L1 稳定高原门槛（S≥21d ∧ ≥5 次 ∧ good/easy），
 * 立即把该词晋升到 L2 辨析训练轨道。继承语义与自动晋升一致；幂等可重复点击。
 */
export function PromoteL2Button({ slug, promoted, onPromoted }: PromoteL2ButtonProps) {
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  if (promoted) return null;

  const promote = async () => {
    setLoading(true);
    try {
      const result = await apiFetch<{ ok: true; alreadyPromoted: boolean; l2DueAt: string | null }>(
        `/l2/${encodeURIComponent(slug)}/promote`,
        { method: "POST" },
      );
      if (result.alreadyPromoted) {
        addToast("success", `${slug} 已在 L2 训练轨道`);
      } else {
        const when = result.l2DueAt ? new Date(result.l2DueAt).toLocaleDateString() : null;
        addToast("success", when ? `${slug} 已晋升 L2，预计 ${when} 进入辨析训练` : `${slug} 已晋升 L2`);
      }
      onPromoted();
    } catch (error) {
      addToast("error", error instanceof BrowserApiError ? error.message : "晋升失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button size="sm" variant="secondary" onClick={promote} disabled={loading} title="跳过稳定度门槛，立即进入 L2 辨析训练轨道">
      <ArrowUpCircle className="h-4 w-4" />
      晋升 L2
    </Button>
  );
}

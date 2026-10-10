import { useState } from "react";
import { Plus, Check, Trash2 } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";

interface AddToReviewButtonProps {
  wordId: string;
  slug: string;
}

export function AddToReviewButton({ wordId, slug }: AddToReviewButtonProps) {
  const [added, setAdded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { addToast } = useToast();

  const addToReview = async () => {
    setLoading(true);
    try {
      await apiFetch<{ ok: true; progressId: string }>("/api/review/cards", {
        method: "POST",
        body: JSON.stringify({ wordId }),
      });
      setAdded(true);
      addToast("success", `${slug} 已添加到复习队列`);
    } catch (error) {
      if (error instanceof BrowserApiError && error.status === 409) {
        setAdded(true);
        addToast("success", `${slug} 已在复习队列`);
      } else {
        addToast("error", "添加失败，请重试");
      }
    } finally {
      setLoading(false);
    }
  };

  // P1 队列编辑：移出复习队列（删除进度行 + 审计；未命中幂等零行）
  const removeFromReview = async () => {
    setRemoving(true);
    try {
      await apiFetch<{ ok: boolean; count: number }>("/api/review/cards/remove", {
        method: "POST",
        body: JSON.stringify({ wordIds: [wordId] }),
      });
      setAdded(false);
      addToast("success", `${slug} 已移出复习队列`);
    } catch (error) {
      addToast("error", "移出失败，请重试");
    } finally {
      setRemoving(false);
    }
  };

  if (added) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled>
          <Check className="h-4 w-4" />
          已在复习队列
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={removeFromReview}
          disabled={removing}
          className="text-[var(--color-accent-2)]"
          title="移出 = 从复习队列删除（重新加入后从头学）；只是暂时不学请用复习卡上的「挂起」"
        >
          <Trash2 className="h-4 w-4" />
          {removing ? "移出中..." : "移出队列"}
        </Button>
      </div>
    );
  }

  return (
    <Button size="sm" onClick={addToReview} disabled={loading}>
      <Plus className="h-4 w-4" />
      {loading ? "添加中..." : "添加到复习"}
    </Button>
  );
}

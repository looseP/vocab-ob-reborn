import { useState } from "react";
import { Plus, Check } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";

interface AddToReviewButtonProps {
  wordId: string;
  slug: string;
}

export function AddToReviewButton({ wordId, slug }: AddToReviewButtonProps) {
  const [added, setAdded] = useState(false);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  const addToReview = async () => {
    setLoading(true);
    try {
      await apiFetch("/review/answer", {
        method: "POST",
        body: JSON.stringify({ rating: "again", wordId }),
      });
      setAdded(true);
      addToast("success", `${slug} 已添加到复习队列`);
    } catch {
      addToast("error", "添加失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  if (added) {
    return (
      <Button variant="secondary" size="sm" disabled>
        <Check className="h-4 w-4" />
        已在复习队列
      </Button>
    );
  }

  return (
    <Button size="sm" onClick={addToReview} disabled={loading}>
      <Plus className="h-4 w-4" />
      {loading ? "添加中..." : "添加到复习"}
    </Button>
  );
}

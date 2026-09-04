import { useState, useEffect } from "react";
import { Settings, Sun, Moon, Monitor, Target, Save } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { useToast } from "@/frontend/components/ui/Toast";

type Theme = "light" | "dark" | "system";

export function SettingsPage() {
  const [theme, setTheme] = useState<Theme>("system");
  const [dailyLimit, setDailyLimit] = useState(50);
  const { addToast } = useToast();

  useEffect(() => {
    const saved = localStorage.getItem("vocab-theme") as Theme;
    if (saved) setTheme(saved);
    const limit = localStorage.getItem("vocab-daily-limit");
    if (limit) setDailyLimit(parseInt(limit, 10));
  }, []);

  const applyTheme = (t: Theme) => {
    setTheme(t);
    localStorage.setItem("vocab-theme", t);
    const root = document.documentElement;
    if (t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
      root.setAttribute("data-theme", "dark");
    } else {
      root.setAttribute("data-theme", "light");
    }
  };

  const saveSettings = () => {
    localStorage.setItem("vocab-daily-limit", String(dailyLimit));
    addToast("success", "设置已保存");
  };

  const themeOptions: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "浅色", icon: Sun },
    { value: "dark", label: "深色", icon: Moon },
    { value: "system", label: "跟随系统", icon: Monitor },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">设置</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">个性化你的学习体验</p>
      </div>

      {/* 主题设置 */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Settings className="h-5 w-5 text-[var(--color-accent)]" />
          <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">外观</h2>
        </div>
        <p className="mb-3 text-sm text-[var(--color-ink-soft)]">选择主题模式</p>
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map((opt) => {
            const Icon = opt.icon;
            const active = theme === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => applyTheme(opt.value)}
                className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-surface-muted)]"
                    : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
                }`}
              >
                <Icon className={`h-6 w-6 ${active ? "text-[var(--color-accent)]" : "text-[var(--color-ink-soft)]"}`} />
                <span className={`text-sm font-medium ${active ? "text-[var(--color-accent)]" : "text-[var(--color-ink)]"}`}>
                  {opt.label}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* 复习设置 */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Target className="h-5 w-5 text-[var(--color-accent)]" />
          <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">复习</h2>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-ink)]">
              每日复习上限
              <Badge tone="accent" className="ml-2">{dailyLimit} 张/天</Badge>
            </label>
            <input
              type="range"
              min={10}
              max={200}
              step={10}
              value={dailyLimit}
              onChange={(e) => setDailyLimit(parseInt(e.target.value, 10))}
              className="w-full accent-[var(--color-accent)]"
            />
            <div className="mt-1 flex justify-between text-xs text-[var(--color-ink-soft)]">
              <span>10</span>
              <span>200</span>
            </div>
          </div>
          <Button onClick={saveSettings}>
            <Save className="h-4 w-4" />
            保存设置
          </Button>
        </div>
      </Card>

      {/* FSRS 参数 */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">FSRS 调度参数</h2>
          <Badge>只读</Badge>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            { label: "请求间隔", value: "0.5s" },
            { label: "最大间隔", value: "365 天" },
            { label: "最小难度", value: "1.0" },
            { label: "最大难度", value: "10.0" },
            { label: "难度衰减", value: "0.85" },
            { label: "稳定性增长", value: "×1.5" },
          ].map((param) => (
            <div key={param.label} className="flex items-center justify-between rounded-lg border border-[var(--color-border)] px-3 py-2">
              <span className="text-[var(--color-ink-soft)]">{param.label}</span>
              <span className="font-mono font-medium text-[var(--color-ink)]">{param.value}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
          FSRS 参数由系统自动管理，确保最优的间隔重复调度。
        </p>
      </Card>
    </div>
  );
}

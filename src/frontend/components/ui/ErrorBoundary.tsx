import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "./Button";

/** 动态 import（路由级代码分割 chunk）加载失败的识别模式。 */
const CHUNK_ERROR_PATTERNS = [
  /dynamically imported module/i,
  /importing a module script failed/i,
  /error loading dynamically imported module/i,
  /loading chunk \d+ failed/i,
  /ChunkLoadError/i,
];

/**
 * 判断是否为路由级代码分割 chunk 加载失败（部署后旧页面引用了已过期的 chunk 文件）。
 * 这类错误刷新即可恢复，应提示"应用已更新"而非通用报错。
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      // A1：chunk 加载失败 = 部署了新版本，旧资源已过期 → 明确提示刷新
      if (this.state.error && isChunkLoadError(this.state.error)) {
        return (
          <div className="flex min-h-[400px] flex-col items-center justify-center text-center">
            <RefreshCw className="mb-4 h-10 w-10 text-[var(--color-accent)]" />
            <h2 className="text-lg font-semibold text-[var(--color-ink)]">应用已更新</h2>
            <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-soft)]">
              检测到页面资源已升级到新版本，刷新即可继续使用（不会丢失任何数据）。
            </p>
            <Button
              className="mt-4"
              variant="primary"
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="h-4 w-4" />
              立即刷新
            </Button>
          </div>
        );
      }
      return (
        <div className="flex min-h-[400px] flex-col items-center justify-center text-center">
          <AlertTriangle className="mb-4 h-10 w-10 text-[var(--color-accent-2)]" />
          <h2 className="text-lg font-semibold text-[var(--color-ink)]">页面出错了</h2>
          <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-soft)]">
            {this.state.error?.message ?? "发生未知错误"}
          </p>
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="h-4 w-4" />
            刷新页面
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

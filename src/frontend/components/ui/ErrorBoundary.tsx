import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "./Button";

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

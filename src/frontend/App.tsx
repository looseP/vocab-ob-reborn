import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { BrowserSessionGate } from "./components/BrowserSessionGate";
import { SiteFrame } from "./components/layout/SiteFrame";
import { ToastProvider } from "./components/ui/Toast";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { Spinner } from "./components/ui/Spinner";
import { OmniPalette } from "./components/search/OmniPalette";

// 路由级代码分割：每个页面独立 chunk，首屏只加载当前路由所需代码。
// 注意：命名导出需映射为 default 供 React.lazy 使用。
const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const ReviewPage = lazy(() => import("./pages/ReviewPage").then((m) => ({ default: m.ReviewPage })));
const L2DrillPage = lazy(() => import("./pages/L2DrillPage").then((m) => ({ default: m.L2DrillPage })));
const WordsPage = lazy(() => import("./pages/WordsPage").then((m) => ({ default: m.WordsPage })));
const WordDetailPage = lazy(() => import("./pages/WordDetailPage").then((m) => ({ default: m.WordDetailPage })));
const NotesPage = lazy(() => import("./pages/NotesPage").then((m) => ({ default: m.NotesPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const ImportPage = lazy(() => import("./pages/ImportPage").then((m) => ({ default: m.ImportPage })));
const CapturePage = lazy(() => import("./pages/CapturePage").then((m) => ({ default: m.CapturePage })));
// L3 子应用全家桶（L3Shell + 9 个子页 + l3Client）独立成块，访问 /l3 时才加载。
const L3Page = lazy(() => import("./pages/L3Page").then((m) => ({ default: m.L3Page })));

/** 路由懒加载的降级态：占满内容区居中显示加载指示，避免布局跳动。 */
function PageSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-[60vh] items-center justify-center">
          <Spinner className="h-8 w-8" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserSessionGate>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<SiteFrame><PageSuspense><HomePage /></PageSuspense></SiteFrame>} />
              <Route path="/dashboard" element={<SiteFrame><PageSuspense><DashboardPage /></PageSuspense></SiteFrame>} />
              <Route path="/review" element={<SiteFrame><PageSuspense><ReviewPage /></PageSuspense></SiteFrame>} />
              <Route path="/review/*" element={<SiteFrame><PageSuspense><ReviewPage /></PageSuspense></SiteFrame>} />
              <Route path="/l2-drill" element={<SiteFrame><PageSuspense><L2DrillPage /></PageSuspense></SiteFrame>} />
              <Route path="/words" element={<SiteFrame><PageSuspense><WordsPage /></PageSuspense></SiteFrame>} />
              <Route path="/words/:slug" element={<SiteFrame><PageSuspense><WordDetailPage /></PageSuspense></SiteFrame>} />
              <Route path="/notes" element={<SiteFrame><PageSuspense><NotesPage /></PageSuspense></SiteFrame>} />
              <Route path="/settings" element={<SiteFrame><PageSuspense><SettingsPage /></PageSuspense></SiteFrame>} />
              <Route path="/import" element={<SiteFrame><PageSuspense><ImportPage /></PageSuspense></SiteFrame>} />
              <Route path="/capture" element={<PageSuspense><CapturePage /></PageSuspense>} />
              <Route path="/l3" element={<SiteFrame><PageSuspense><L3Page /></PageSuspense></SiteFrame>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <OmniPalette />
          </BrowserRouter>
        </BrowserSessionGate>
      </ToastProvider>
    </ErrorBoundary>
  );
}

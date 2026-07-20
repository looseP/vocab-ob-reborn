import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { BrowserSessionGate } from "./components/BrowserSessionGate";
import { SiteFrame } from "./components/layout/SiteFrame";
import { ToastProvider } from "./components/ui/Toast";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { HomePage } from "./pages/HomePage";
import { DashboardPage } from "./pages/DashboardPage";
import { ReviewPage } from "./pages/ReviewPage";
import { WordsPage } from "./pages/WordsPage";
import { WordDetailPage } from "./pages/WordDetailPage";
import { NotesPage } from "./pages/NotesPage";
import { L3Shell } from "./components/L3Shell";

function L3Page() {
  return <L3Shell activeSection="home" onNavigate={() => {}}><L3HomeContent /></L3Shell>;
}

function L3HomeContent() {
  return (
    <div className="p-8 text-center">
      <h2 className="section-title text-2xl font-bold text-[var(--color-ink)]">L3 进阶研究</h2>
      <p className="mt-2 text-[var(--color-ink-soft)]">知识图谱、提案、推荐系统</p>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserSessionGate>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<SiteFrame><HomePage /></SiteFrame>} />
              <Route path="/dashboard" element={<SiteFrame><DashboardPage /></SiteFrame>} />
              <Route path="/review" element={<SiteFrame><ReviewPage /></SiteFrame>} />
              <Route path="/review/*" element={<SiteFrame><ReviewPage /></SiteFrame>} />
              <Route path="/words" element={<SiteFrame><WordsPage /></SiteFrame>} />
              <Route path="/words/:slug" element={<SiteFrame><WordDetailPage /></SiteFrame>} />
              <Route path="/notes" element={<SiteFrame><NotesPage /></SiteFrame>} />
              <Route path="/l3" element={<SiteFrame><L3Page /></SiteFrame>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </BrowserSessionGate>
      </ToastProvider>
    </ErrorBoundary>
  );
}

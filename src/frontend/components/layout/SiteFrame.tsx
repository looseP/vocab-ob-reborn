import type { ReactNode } from "react";
import { SiteHeader } from "./SiteHeader";
import { MobileTabBar } from "./MobileTabBar";
import { BackToTopButton } from "./BackToTopButton";

export function SiteFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      {/* 移动端底部固定导航占用底部空间，内容区留白（pb-24），桌面端恢复常规 padding */}
      <main className="mx-auto w-full max-w-7xl px-4 py-8 pb-24 sm:px-6 md:pb-8 lg:px-8">
        {children}
      </main>
      <MobileTabBar />
      <BackToTopButton />
    </>
  );
}

import type { ReactNode } from "react";
import { SiteHeader } from "./SiteHeader";
import { BackToTopButton } from "./BackToTopButton";

export function SiteFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
      <BackToTopButton />
    </>
  );
}

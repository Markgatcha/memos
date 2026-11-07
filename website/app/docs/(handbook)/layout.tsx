import type { ReactNode } from "react";
import { sections } from "@/lib/docs";
import DocsNav from "./_components/DocsNav";
import DocsToc from "./_components/DocsToc";

export default function HandbookLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen pb-24 pt-24">
      <div className="mx-auto max-w-[1440px] px-5 sm:px-6">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[238px_minmax(0,1fr)] xl:grid-cols-[238px_minmax(0,1fr)_200px] xl:gap-12">
          <DocsNav sections={sections} />
          <div className="min-w-0">{children}</div>
          <DocsToc />
        </div>
      </div>
    </main>
  );
}

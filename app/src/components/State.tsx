import type { ReactNode } from "react";

export function State({ title, titleId, detail, children }: { title: string; titleId?: string; detail: string; children?: ReactNode }) {
  return (
    <div className="state" role="status">
      <h2 id={titleId}>{title}</h2>
      <p>{detail}</p>
      {children}
    </div>
  );
}

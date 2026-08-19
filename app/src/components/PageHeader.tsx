import type { ReactNode } from "react";
import { Fact } from "./Fact";
import "./page-header.css";

export interface PageHeaderStat { label: string; value: string }

export function PageHeader({ eyebrow, title, titleId, lede, actions, stats, statsLabel }: {
  eyebrow: string;
  title: string;
  titleId: string;
  lede: ReactNode;
  actions?: ReactNode;
  stats?: readonly PageHeaderStat[];
  statsLabel?: string;
}) {
  return (
    <header className="page-header" aria-labelledby={titleId}>
      <div className="page-header-main">
        <div className="page-header-copy">
          <p className="eyebrow">{eyebrow}</p>
          <h1 id={titleId}>{title}</h1>
          <p className="page-header-lede">{lede}</p>
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
      {stats && stats.length > 0 && (
        <div className="page-header-stats" role="group" aria-label={statsLabel ?? "Summary"}>
          {stats.map((stat) => <Fact key={stat.label} label={stat.label} value={stat.value} />)}
        </div>
      )}
    </header>
  );
}

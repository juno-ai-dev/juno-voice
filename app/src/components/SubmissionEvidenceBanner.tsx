import { Link } from "react-router";

// Shown on a page while a persisted submission lock exists and its owning
// modal is closed, so the evidence stays reachable from anywhere on the page.
export function SubmissionEvidenceBanner({ to }: { to: string }) {
  return (
    <p className="notice" role="status">
      A previous submission is not canonically confirmed.{" "}
      <Link to={to}>Review the stored transaction evidence</Link> before preparing another action.
    </p>
  );
}

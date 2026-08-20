import { useNavigate } from "react-router";

// Always close to the explicit parent. A modal may have replaced its parent
// during persisted-lock auto-open, so history back can leave the page entirely.
export function useCloseModal(parentPath: string) {
  const navigate = useNavigate();
  return () => { void navigate(parentPath, { replace: true }); };
}

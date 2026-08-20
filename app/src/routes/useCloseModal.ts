import { useLocation, useNavigate } from "react-router";

export const MODAL_CLOSE_REPLACE_STATE = { junoVoiceModalClose: "replace" } as const;

// Pushed modals close with Back so normal history stays intact. Direct loads
// and persisted-lock auto-opens have no parent entry to return to, so they
// replace their route with the explicit parent instead.
export function useCloseModal(parentPath: string) {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    const replace = location.key === "default"
      || (location.state as { junoVoiceModalClose?: unknown } | null)?.junoVoiceModalClose === "replace";
    if (replace) void navigate(parentPath, { replace: true });
    else void navigate(-1);
  };
}

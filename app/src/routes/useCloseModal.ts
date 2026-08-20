import { useLocation, useNavigate } from "react-router";

// Closing a route-addressed modal means leaving its URL. When the modal route
// was opened from its parent page, going back closes it and preserves history;
// on a direct load there is no entry behind us, so replace with the parent.
export function useCloseModal(parentPath: string) {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    if (location.key === "default") void navigate(parentPath, { replace: true });
    else void navigate(-1);
  };
}

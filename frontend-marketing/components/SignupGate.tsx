import type { ReactNode } from "react";
import { useAuthBootstrap } from "./AuthBootstrapProvider";

export function SignupGate({ children }: { children: ReactNode }) {
  const { status } = useAuthBootstrap();

  // Fail open: the backend's SIGNUP_DISABLED guard is the security boundary,
  // so hide signup CTAs only on an explicit signupEnabled:false. While the
  // bootstrap status is loading, failed to fetch, or came from an older
  // backend without the field, the CTAs stay in the markup — this keeps them
  // in the server-rendered HTML (SEO, no post-hydration pop-in) and prevents a
  // transient /api failure from silently stripping every signup entry point.
  return status?.signupEnabled === false ? null : children;
}

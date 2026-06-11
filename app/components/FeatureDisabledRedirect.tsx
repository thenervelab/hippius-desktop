"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Route guard for pages behind a build-time feature flag (see
 * `app/lib/featureFlags.ts`). While the flag is off, the page renders
 * nothing and is client-side replaced with the overview, so a direct URL
 * (deep link, stale bookmark, manual navigation) can't reach the gated
 * surface. The page code itself stays in the bundle — same
 * keep-don't-delete policy as the VPN flag.
 *
 * Client-side because the app is a static export: there is no server to
 * issue a real redirect, and the flag is a literal constant so the guard
 * resolves instantly on mount with no flash of gated content.
 */
export default function FeatureDisabledRedirect({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) router.replace("/");
  }, [enabled, router]);

  if (!enabled) return null;
  return <>{children}</>;
}

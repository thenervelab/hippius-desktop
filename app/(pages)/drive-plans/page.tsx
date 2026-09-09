"use client";

import { FC, useEffect } from "react";
import { useRouter } from "next/navigation";

import { BILLING_ROUTE } from "@/app/lib/routes";

/**
 * The Subscription Plans page is gone — plans live on Billing, in Settings.
 *
 * The route stays as a redirect rather than being deleted outright: this
 * app is a static export with no server rewrites, so a deleted route is a
 * blank screen, and the path is still reachable from a bookmark, an old
 * in-app link, or a deep link minted before the move. Sending those to
 * Billing is what the user wanted anyway.
 */
const DrivePlansPage: FC = () => {
  const router = useRouter();

  useEffect(() => {
    router.replace(BILLING_ROUTE);
  }, [router]);

  return null;
};

export default DrivePlansPage;

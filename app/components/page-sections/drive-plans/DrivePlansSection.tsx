"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CoinsIcon } from "@/components/ui/icons";
import useDrivePlans from "@/lib/hooks/api/useDrivePlans";
import {
  useCancelDriveSubscription,
  useChangeDrivePlan,
  useDriveCheckoutIntent,
  useDriveSubscription,
  useStartDriveCardCheckout,
  useSubscribeDrivePlan,
} from "@/lib/hooks/api/useDriveSubscription";
import { useUserCredits } from "@/lib/hooks/api/useUserCredits";
import {
  chargeAmount,
  currentPlanCode,
  formatPlanStorage,
  isManagedByConsole,
  isUpgrade,
  managedByLabel,
  type DrivePlan,
  type DrivePlanCode,
} from "@/lib/types/drive-plans";
import { cn } from "@/lib/utils";

import type { DrivePlanAction } from "./DrivePlanCard";
import DrivePlanFlowDialog, { type DrivePlanFlow } from "./DrivePlanFlowDialog";
import DrivePlansGrid from "./DrivePlansGrid";
import DriveSubscribeDialog from "./DriveSubscribeDialog";
import type { PaymentRail } from "./PaymentMethodChoice";

/** How long to wait for the on-chain write to show up in the subscription read. */
const CONFIRM_TIMEOUT_MS = 60_000;
/** How often to re-read the subscription while waiting for it. */
const CONFIRM_POLL_MS = 3_000;

interface PendingWrite {
  kind: "plan" | "cancel";
  target?: DrivePlanCode;
  startedAt: number;
}

/** Every read the plan surfaces share, refreshed together after a write. */
const REFRESH_KEYS = [
  ["drive-subscription"],
  ["user-credits"],
  ["storage-overview"],
  ["drive-subscription-history"],
];

/**
 * The plans and everything that happens when one is chosen: confirm, the
 * write, the wait for the chain to agree, and the success or error card.
 * Logic mirrors the console's plans page; only the card design differs.
 */
const DrivePlansSection: FC<{ className?: string }> = ({ className }) => {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [confirm, setConfirm] = useState<{
    plan: DrivePlan;
    action: DrivePlanAction;
  } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [flow, setFlow] = useState<DrivePlanFlow | null>(null);
  const [rail, setRail] = useState<PaymentRail>("credits");
  const [pendingIntent, setPendingIntent] = useState<string | null>(null);

  const { data: plans, isLoading: isPlansLoading } = useDrivePlans();
  const { data: subscription, isLoading: isSubLoading } = useDriveSubscription({
    refetchInterval: pending ? CONFIRM_POLL_MS : false,
  });
  const { data: creditsData } = useUserCredits();
  const subscribe = useSubscribeDrivePlan();
  const change = useChangeDrivePlan();
  const cancel = useCancelDriveSubscription();
  const cardCheckout = useStartDriveCardCheckout();
  const intent = useDriveCheckoutIntent(pendingIntent);

  // Credits come back scaled by 10^18; plan prices are plain credits.
  const credits = useMemo(
    () =>
      creditsData === undefined ? null : Number(creditsData.planck) / 1e18,
    [creditsData],
  );
  const code = currentPlanCode(subscription);
  const managedElsewhere = !isManagedByConsole(subscription);
  const isWriting =
    subscribe.isPending ||
    change.isPending ||
    cancel.isPending ||
    cardCheckout.isPending;
  const busyPlanCode =
    pending?.kind === "plan"
      ? (pending.target ?? null)
      : (confirm?.plan.code ?? null);

  const refresh = () => {
    for (const key of REFRESH_KEYS)
      void queryClient.invalidateQueries({ queryKey: key });
  };

  // The write landed once the read agrees with what we asked for.
  useEffect(() => {
    if (!pending || !subscription) return;
    const done =
      pending.kind === "cancel"
        ? !subscription.active
        : subscription.active && subscription.plan === pending.target;
    if (!done) return;
    refresh();
    if (pending.kind === "plan") {
      setFlow((f) => (f ? { stage: "success", plan: f.plan } : f));
    } else {
      setConfirmCancel(false);
      toast.success("Subscription cancelled. You are back on the Free plan.");
    }
    setPending(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscription, pending]);

  // Stop waiting eventually rather than polling forever if the chain is slow.
  const startedAt = pending?.startedAt ?? null;
  const pendingKind = pending?.kind ?? null;
  useEffect(() => {
    if (startedAt === null) return;
    const remaining = Math.max(
      0,
      CONFIRM_TIMEOUT_MS - (Date.now() - startedAt),
    );
    const timer = setTimeout(() => {
      const message =
        "Still confirming on chain. This page will catch up shortly. Refresh if it has not in a minute.";
      if (pendingKind === "plan")
        setFlow((f) => (f ? { stage: "error", plan: f.plan, message } : f));
      else {
        setConfirmCancel(false);
        toast.info(message);
      }
      setPending(null);
    }, remaining);
    return () => clearTimeout(timer);
  }, [startedAt, pendingKind]);

  // A card payment ends the same way a balance payment does.
  const intentStatus = intent.data?.status;
  const intentPlan = intent.data?.plan;
  const intentError = intent.data?.error;
  useEffect(() => {
    if (!pendingIntent) return;
    if (intentStatus === "fulfilled") {
      refresh();
      const plan = plans?.find((p) => p.code === intentPlan);
      if (plan) setFlow({ stage: "success", plan });
      setPendingIntent(null);
    } else if (intentStatus === "failed") {
      const plan = plans?.find((p) => p.code === intentPlan);
      if (plan)
        setFlow({
          stage: "error",
          plan,
          message: intentError ?? "The card payment did not go through.",
        });
      setPendingIntent(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIntent, intentStatus, intentPlan, intentError, plans]);

  const creditsShortFor = (plan: DrivePlan) => {
    const cost = chargeAmount(plan, "monthly");
    return credits !== null && cost > credits;
  };

  // Default the rail to card when the balance is short; the user can flip it.
  useEffect(() => {
    if (confirm?.action === "subscribe")
      setRail(creditsShortFor(confirm.plan) ? "card" : "credits");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm?.plan.code, confirm?.action]);

  const actionFor = (plan: DrivePlan): DrivePlanAction => {
    if (plan.code === code) return plan.is_free ? "none" : "cancel";
    if (plan.is_free) return "none";
    if (!subscription?.active) return "subscribe";
    const current = plans?.find((p) => p.code === code);
    return isUpgrade(current, plan) ? "upgrade" : "downgrade";
  };

  const disabledReasonFor = (plan: DrivePlan, action: DrivePlanAction) => {
    if (action === "current" || action === "none") return undefined;
    if (managedElsewhere) return `Managed in ${managedByLabel(subscription)}`;
    return undefined;
  };

  const runPlanWrite = (plan: DrivePlan, action: DrivePlanAction) => {
    const target = plan.code as Exclude<DrivePlanCode, "free">;
    setConfirm(null);
    setFlow({ stage: "processing", plan });
    const write = action === "subscribe" ? subscribe : change;
    write.mutate(
      { plan: target, period: "monthly" },
      {
        onSuccess: () =>
          setPending({ kind: "plan", target, startedAt: Date.now() }),
        onError: (err) =>
          setFlow({
            stage: "error",
            plan,
            message: err.message || "The plan could not be changed.",
          }),
      },
    );
  };

  const runCardCheckout = (plan: DrivePlan) => {
    cardCheckout.mutate(
      { plan: plan.code as Exclude<DrivePlanCode, "free">, period: "monthly" },
      {
        onSuccess: (out) => {
          setConfirm(null);
          setPendingIntent(out.intent_id);
          setFlow({ stage: "processing", plan });
          void openUrl(out.checkout_url);
          toast.info(
            "Finish the payment in your browser. This page updates when it lands.",
          );
        },
        onError: (err) =>
          toast.error(err.message || "Could not start the card payment"),
      },
    );
  };

  const runCancel = () => {
    cancel.mutate(undefined, {
      onSuccess: () => setPending({ kind: "cancel", startedAt: Date.now() }),
      onError: (err) => {
        setConfirmCancel(false);
        toast.error(err.message || "Could not cancel the subscription");
      },
    });
  };

  const onAction = (plan: DrivePlan, action: DrivePlanAction) => {
    if (action === "cancel") setConfirmCancel(true);
    else if (
      action === "subscribe" ||
      action === "upgrade" ||
      action === "downgrade"
    )
      setConfirm({ plan, action });
  };

  // Arriving with ?plan=<code> from the empty Drive opens that plan's confirm
  // once the reads have landed, then clears the param so a refresh does not.
  const requestedPlan = searchParams.get("plan");
  const openedRequestedRef = useRef(false);
  useEffect(() => {
    if (!requestedPlan || openedRequestedRef.current) return;
    if (!plans || isSubLoading) return;
    openedRequestedRef.current = true;
    router.replace("/drive-plans");
    const plan = plans.find((p) => p.code === requestedPlan);
    if (!plan) return;
    const action = actionFor(plan);
    if (
      action === "subscribe" ||
      action === "upgrade" ||
      action === "downgrade"
    )
      setConfirm({ plan, action });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedPlan, plans, isSubLoading]);

  const freePlan = plans?.find((p) => p.is_free);

  return (
    <section
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-[8px] border border-grey-dark-100 bg-grey-light-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)] dark:border-black-300 dark:bg-black-primary-bg",
        className,
      )}
    >
      <div className="flex items-center gap-1 px-3 py-2.5">
        <CoinsIcon className="size-4 text-primary-40 dark:text-primary-brand-dark" />
        <p className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
          Subscription plans
        </p>
      </div>
      {/* Inner panel: border-t + top corners only — the outer card supplies
          the other three edges (billing's CreditsWidget pattern). */}
      <div className="w-full rounded-t-[8px] border-t border-grey-dark-100 bg-white p-3 dark:border-black-300 dark:bg-black-600">
        {isPlansLoading || (!plans && isSubLoading) ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-[305px] animate-pulse rounded-[8px] bg-grey-light-300 dark:bg-black-300"
              />
            ))}
          </div>
        ) : !plans || plans.length === 0 ? (
          <p className="p-6 text-sm text-grey-50 dark:text-grey-dark-700">
            No plans available right now.
          </p>
        ) : (
          <DrivePlansGrid
            plans={plans}
            currentCode={code}
            actionFor={actionFor}
            disabledReasonFor={disabledReasonFor}
            busyPlanCode={busyPlanCode}
            disabled={isWriting || pending !== null}
            onAction={onAction}
          />
        )}
      </div>

      <DriveSubscribeDialog
        open={confirm !== null}
        plan={confirm?.plan ?? null}
        action={confirm?.action ?? null}
        rail={rail}
        onRailChange={setRail}
        credits={credits}
        creditsShort={confirm ? creditsShortFor(confirm.plan) : false}
        isWriting={isWriting}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.action === "subscribe" && rail === "card")
            runCardCheckout(confirm.plan);
          else runPlanWrite(confirm.plan, confirm.action);
        }}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel subscription"
        description={`You will go back to the Free plan${
          freePlan
            ? ` with ${formatPlanStorage(freePlan.storage_bytes)} of storage`
            : ""
        }. If you are storing more than that, uploads pause until you are under the limit again.`}
        confirmText={
          cancel.isPending || pending?.kind === "cancel"
            ? "Cancelling…"
            : "Cancel subscription"
        }
        cancelText="Keep my plan"
        variant="danger"
        isLoading={cancel.isPending || pending?.kind === "cancel"}
        confirmDisabled={cancel.isPending || pending !== null}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending && pending?.kind !== "cancel")
            setConfirmCancel(false);
        }}
        onConfirm={runCancel}
      />

      <DrivePlanFlowDialog
        flow={flow}
        onContinue={() => setFlow(null)}
        onRetry={() => {
          if (!flow) return;
          const action = actionFor(flow.plan);
          if (
            action === "subscribe" ||
            action === "upgrade" ||
            action === "downgrade"
          )
            runPlanWrite(flow.plan, action);
          else setFlow(null);
        }}
        onBack={() => {
          if (!flow) return;
          const action = actionFor(flow.plan);
          setFlow(null);
          if (
            action === "subscribe" ||
            action === "upgrade" ||
            action === "downgrade"
          )
            setConfirm({ plan: flow.plan, action });
        }}
      />
    </section>
  );
};

export default DrivePlansSection;

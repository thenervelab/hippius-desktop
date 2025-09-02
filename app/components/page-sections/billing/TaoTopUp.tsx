/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { toast } from "sonner";
import { Tag } from "lucide-react";
import Form from "next/form";
import useDepositAddress from "@/app/lib/hooks/useDepositAddress";
import { ChangeEvent, useMemo, useState } from "react";
import { InfoCircle, TaoLogo, Wallet } from "@/components/ui/icons";
import { CardButton, Graphsheet } from "@/components/ui";
import { BN } from "@polkadot/util";
import { P } from "@/components/ui/typography";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import * as Tabs from "@radix-ui/react-tabs";
import { CopyableCell } from "@/components/ui/alt-table";
import useTaoPrice from "@/app/lib/hooks/useTaoPrice";

const PAYMENT_OPTIONS_TABS = ["wallet", "manual"] as const;

type OptionTypes = (typeof PAYMENT_OPTIONS_TABS)[number];

const getTabLabels = (type: OptionTypes) => {
    switch (type) {
        case "wallet":
            return { label: "Pay with Bittensor Wallet", Icon: Wallet };
        case "manual":
            return { label: "Pay Manually", Icon: Tag };
    }
};

const MINIMUM_USD_AMOUNT = 2;

const BITTENSOR_GENESIS =
    "0x9c4ca2cd3124c47781d7ea607d40d8d62fc54bc4a2f97a514b9b9e90ea839b89";
const BITTENSOR_SS58_FORMAT = 42;

const getExtension = async () => {
    const { injectedWeb3 } = window as unknown as Window & { injectedWeb3: any };

    if (!injectedWeb3) {
        throw new Error("No web3 extension found");
    }

    // Try Talisman first, then fall back to Polkadot.js
    if (injectedWeb3.talisman) {
        const extension = await injectedWeb3.talisman.enable("Hippius Web");
        await extension.accounts.get({
            ss58Format: BITTENSOR_SS58_FORMAT,
            genesisHash: BITTENSOR_GENESIS,
        });
        return extension;
    }

    if (injectedWeb3["polkadot-js"]) {
        const extension = await injectedWeb3["polkadot-js"].enable("Hippius Web");
        await extension.accounts.get({
            ss58Format: BITTENSOR_SS58_FORMAT,
            genesisHash: BITTENSOR_GENESIS,
        });
        return extension;
    }

    throw new Error("Please install Talisman or Polkadot.js extension");
};

interface TaoTopUpProps {
    closeDialog: () => void;
}

const TaoTopUp: React.FC<TaoTopUpProps> = ({ closeDialog }) => {
    const { data: taoPriceData } = useTaoPrice();
    const { data: depositAddress } = useDepositAddress();
    const { refetch: refetchUserCredits } = useUserCredits();
    const [amountValue, setAmountValue] = useState("");

    const userIntegerAmount = useMemo(() => {
        const numberVal = Number(amountValue);
        return isNaN(numberVal) ? 0 : numberVal;
    }, [amountValue]);

    const userTaoAmountFromUsd = useMemo(() => {
        if (taoPriceData) {
            return Number(
                (userIntegerAmount / Number(taoPriceData.price_usd)).toFixed(9)
            );
        }
        return 0;
    }, [taoPriceData, userIntegerAmount]);

    async function handleTopUpBalance(formData: FormData) {
        const amount = Number(
            formData.get("amount")?.toString().trim().toLowerCase()
        );

        if (!taoPriceData) {
            toast.error("Failed to load current tao price. Please try again.");
            return;
        }

        if (amount < MINIMUM_USD_AMOUNT) {
            toast.error(`Minimum USD amount is $${MINIMUM_USD_AMOUNT}`);
            return;
        }

        const minimumTaoAmount =
            MINIMUM_USD_AMOUNT / Number(Number(taoPriceData.price_usd).toFixed(4));

        if (!userTaoAmountFromUsd || amount < minimumTaoAmount) {
            toast.error(`Minimum tao amount is ${minimumTaoAmount}`);
            return;
        }
        if (!depositAddress) {
            toast.error("An error occured. Please try again.");
            console.error("DEPO ADDR", depositAddress);
            return;
        }

        try {
            const extension = await getExtension();

            const accounts = await extension.accounts.get({
                ss58Format: BITTENSOR_SS58_FORMAT,
                genesisHash: BITTENSOR_GENESIS,
            });

            if (accounts.length === 0) {
                throw new Error(
                    "No accounts found in wallet. Please add a Bittensor account to your wallet."
                );
            }

            let senderAccount;

            if (accounts.length > 1) {
                const accountOptions = accounts.map((acc: any) => ({
                    label: `${acc.name || "Unnamed"} (${acc.address.slice(
                        0,
                        6
                    )}...${acc.address.slice(-4)})`,
                    value: acc,
                }));

                senderAccount = await new Promise((resolve, reject) => {
                    const toastId = toast(
                        <div className="w-full relative">
                            <P className="text-center">Select a Wallet</P>
                            <div className="flex flex-col w-full mt-3 gap-y-4">
                                {accountOptions.map((option: any) => (
                                    <CardButton
                                        key={option.value.address}
                                        className="w-full justify-center text-center"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            resolve(option.value);
                                            toast.dismiss(toastId);
                                        }}
                                    >
                                        {option.label}
                                    </CardButton>
                                ))}
                            </div>
                        </div>,
                        {
                            position: "bottom-center",
                            duration: 30000, // 30 seconds to choose
                            className: "pointer-events-auto z-10",
                        }
                    );

                    // After 30 seconds, reject if no selection
                    setTimeout(() => {
                        toast.dismiss(toastId);
                        reject(new Error("Account selection timed out. Please try again."));
                    }, 30000);
                });
            } else {
                senderAccount = accounts[0];
                toast.success(
                    `Using account: ${senderAccount.name || "Unnamed"
                    } (${senderAccount.address.slice(
                        0,
                        6
                    )}...${senderAccount.address.slice(-4)})`
                );
            }

            if (!senderAccount) {
                throw new Error("No account selected for sending TAO.");
            }

            if (!depositAddress) {
                throw new Error("No deposit address provided.");
            }

            const taoAmount = userIntegerAmount / Number(taoPriceData.price_usd);

            const decimals = 9; // Bittensor uses 9 decimals
            const planckAmount = new BN(
                Math.floor(userTaoAmountFromUsd * Math.pow(10, decimals)).toString()
            );

            if (planckAmount.isZero()) {
                toast.error("Invalid amount");
                throw new Error("Invalid amount: converts to 0 planck");
            }

            const wsProvider = new WsProvider(
                "wss://entrypoint-finney.opentensor.ai"
            );

            let bittensorApi: ApiPromise | null = null;

            try {
                bittensorApi = await ApiPromise.create({
                    provider: wsProvider,
                    types: {
                        Balance: "u64",
                        SubNetwork: "u16",
                        NeuronMetadata: {
                            version: "u32",
                            ip: "u128",
                            port: "u16",
                            ipType: "u8",
                            uid: "u32",
                            modality: "u8",
                            hotkey: "AccountId",
                            coldkey: "AccountId",
                            active: "u32",
                            lastUpdate: "u64",
                            priority: "u64",
                            stake: "u64",
                            rank: "u64",
                            trust: "u64",
                            consensus: "u64",
                            incentive: "u64",
                            dividends: "u64",
                            emission: "u64",
                            bonds: "Vec<(u32, u64)>",
                            weights: "Vec<(u32, u64)>",
                        },
                    },
                });

                await bittensorApi.isReady;
                console.log("Bittensor API ready");

                const tokenDecimals = bittensorApi.registry.chainDecimals[0];
                const decimalsMultiplier = Math.pow(10, tokenDecimals);
                console.log("Chain token decimals:", tokenDecimals);

                // Check account balance
                const accountInfo = await bittensorApi.query.system.account(
                    senderAccount.address
                );
                const balanceInPlanck = new BN(
                    (accountInfo as any).data.free.toString()
                );
                const balanceInTao =
                    Number(balanceInPlanck.toString()) / decimalsMultiplier;
                const requiredTao = taoAmount;
                const feesInTao = 0.01; // Estimate 0.01 TAO for fees
                const totalRequiredTao = requiredTao + feesInTao;

                console.log("Account balance:", {
                    planck: balanceInPlanck.toString(),
                    tao: balanceInTao.toFixed(tokenDecimals),
                });
                console.log("Required amount:", {
                    usd: amount,
                    tao: requiredTao.toFixed(tokenDecimals),
                    fees: feesInTao,
                    total: totalRequiredTao.toFixed(tokenDecimals),
                });

                if (balanceInTao < totalRequiredTao) {
                    throw new Error(
                        `Insufficient balance. You have ${balanceInTao.toFixed(
                            4
                        )} TAO but need ${totalRequiredTao.toFixed(
                            4
                        )} TAO (including ${feesInTao} TAO fees)`
                    );
                }

                const transfer = bittensorApi.tx.balances.transferKeepAlive(
                    depositAddress,
                    planckAmount
                );

                toast("Please confirm the transaction in your wallet");

                const unsub = await transfer.signAndSend(
                    senderAccount.address,
                    { signer: extension.signer },
                    ({ status, events = [], dispatchError }) => {
                        if (status.isInvalid) {
                            toast.error(
                                "The transaction was invalid. Please check your balance and try again."
                            );
                            unsub();
                        } else if (status.isReady) {
                            toast.success("Transaction is ready to be processed");
                        } else if (status.isBroadcast) {
                            toast.success("Transaction has been broadcast to the network");
                        } else if (status.isInBlock) {
                            // Check for specific errors
                            if (dispatchError) {
                                let errorMessage;
                                if (dispatchError.isModule && bittensorApi) {
                                    const decoded = bittensorApi.registry.findMetaError(
                                        dispatchError.asModule
                                    );
                                    errorMessage = `${decoded.section}.${decoded.method
                                        }: ${decoded.docs.join(" ")}`;
                                } else {
                                    errorMessage = dispatchError.toString();
                                }
                                console.error("Error Message", errorMessage);
                                toast.error("Transaction Failed");
                            } else {
                                toast.success(
                                    `Transaction included in block ${status.asInBlock.toString()}`
                                );
                            }
                        } else if (status.isFinalized) {
                            // Look for ExtrinsicSuccess or ExtrinsicFailed events
                            const success = events.find(
                                ({ event }) =>
                                    bittensorApi &&
                                    bittensorApi.events.system.ExtrinsicSuccess.is(event)
                            );

                            if (success) {
                                toast.success(
                                    `Transaction finalized in block ${status.asFinalized.toString()}`
                                );
                                refetchUserCredits();
                                closeDialog();
                            }

                            unsub();
                        }
                    }
                );
            } catch (error) {
                console.error("Error:", error);
                let errorMessage =
                    error instanceof Error
                        ? error.message
                        : "Failed to process transaction";

                // Check for signature verification error
                if (typeof error === "object" && error !== null && "error" in error) {
                    const errorObj = error as { error: string };
                    if (errorObj.error.includes("mnemonic")) {
                        errorMessage =
                            "Unable to verify transaction at this time. Please try again later or contact support.";
                    }
                }

                toast.error(errorMessage);
            } finally {
                if (bittensorApi) {
                    await bittensorApi.disconnect();
                }
                if (wsProvider) {
                    await wsProvider.disconnect();
                }
            }
        } catch (error) {
            if (error instanceof Error) {
                toast.error(error.message);
            } else {
                toast.error("An error occured. Please try again or contact support");
            }
        }
    }

    const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        setAmountValue(e.currentTarget.value);
    };

    return (
        <div className="mt-4 animate-fade-in-0.3 text-grey-10 font-medium">
            <div>
                <Tabs.Root defaultValue="wallet" className="w-full">
                    <Tabs.List className="flex mb-3 gap-y-2 flex-wrap text-sm font-medium border border-grey-80 rounded">
                        {PAYMENT_OPTIONS_TABS.map((t) => {
                            const { label, Icon } = getTabLabels(t);
                            return (
                                <Tabs.Trigger
                                    className="group relative grow text-center justify-center p-2 text-grey-70 flex items-center gap-1.5 data-[state=active]:text-primary-50 data-[state=inactive]:hover:opacity-80 duration-300"
                                    key={t}
                                    value={t}
                                >
                                    <div className="absolute w-full h-full p-px opacity-0 scale-95 group-data-[state=active]:opacity-100 group-data-[state=active]:scale-100 duration-300">
                                        <Graphsheet
                                            majorCell={{
                                                lineColor: [31, 80, 189, 1.0],
                                                lineWidth: 2,
                                                cellDim: 35,
                                            }}
                                            minorCell={{
                                                lineColor: [31, 80, 189, 0.5],
                                                lineWidth: 2,
                                                cellDim: 2,
                                            }}
                                            className="w-full h-full left-0 opacity-10"
                                        />
                                        <div className="absolute w-full h-full top-0">
                                            <div className="absolute w-full h-full">
                                                <div className="size-1.5 border border-primary-50 border-r-0 border-b-0 absolute left-0 top-0" />
                                                <div className="size-1.5 border border-primary-50 border-r-0 border-t-0 absolute left-0 bottom-0" />
                                                <div className="size-1.5 border border-primary-50 border-l-0 border-t-0 absolute right-0 bottom-0" />
                                                <div className="size-1.5 border border-primary-50 border-l-0 border-b-0 absolute right-0 top-0" />
                                            </div>
                                        </div>
                                    </div>
                                    <Icon className="size-4 relative" />
                                    <span className="relative">{label}</span>
                                </Tabs.Trigger>
                            );
                        })}
                    </Tabs.List>
                    <Tabs.Content value="wallet">
                        <Form action={handleTopUpBalance} className="animate-fade-in-0.3">
                            <div className="flex flex-col items-start mt-5">
                                <label className="text-sm text-grey-70 font-medium mb-2">
                                    Amount
                                </label>
                                <div className="relative text-grey-30 flex items-center w-full">
                                    <input
                                        value={amountValue}
                                        onChange={onInputChange}
                                        type="number"
                                        name="amount"
                                        min={MINIMUM_USD_AMOUNT}
                                        placeholder="0.00"
                                        className="pl-8 border border-grey-80 px-4 bg-white h-14 rounded-[8px] w-full placeholder:text-grey-50 outline-none hover:border-grey-60 active:border-primary-70 focus:border-primary-70 duration-300"
                                    />
                                    <span className="absolute left-4 text-grey-10 font-semibold">
                                        $
                                    </span>
                                </div>
                            </div>

                            <div className="flex flex-col gap-y-4">
                                <div className="flex flex-col gap-y-4">
                                    <div className="flex items-center w-full justify-between mt-4">
                                        <div className="flex items-center gap-2">
                                            <TaoLogo className="size-3 text-grey-10" />
                                            <span className="text-grey-70">Current $TAO Price</span>
                                        </div>

                                        <span>
                                            $
                                            {taoPriceData
                                                ? Number(taoPriceData.price_usd).toFixed(2)
                                                : "---"}{" "}
                                        </span>
                                    </div>
                                    <div className="flex items-center w-full justify-between">
                                        <div className="flex items-center gap-2">
                                            <TaoLogo className="size-3 text-grey-10" />
                                            <span className="text-grey-70">Amount in $TAO</span>
                                        </div>

                                        <span>{userTaoAmountFromUsd.toFixed(3)} TAO</span>
                                    </div>

                                    <div className="flex items-center w-full justify-between">
                                        <div className="flex items-center gap-2">
                                            <Wallet className="size-5 text-grey-10" />
                                            <span className="text-grey-70">Credits to Receive</span>
                                        </div>

                                        <span>≈{userIntegerAmount} Credits</span>
                                    </div>
                                </div>

                                <CardButton type="submit" className="w-full mt-auto absolute bottom-0">
                                    Add Credits
                                </CardButton>
                            </div>
                        </Form>
                    </Tabs.Content>
                    <Tabs.Content value="manual">
                        <div className="animate-fade-in-0.3 pt-2">
                            <div className="text-sm">
                                <span className="text-grey-70">Deposit Address On Chain</span> -{" "}
                                <b>SS58 Bittensor Chain</b>
                            </div>

                            <div className="mt-2 border border-grey-80 rounded-[8px]">
                                <CopyableCell
                                    title="Copy Deposit Address"
                                    toastMessage="Deposit Address Copied Successfully!"
                                    copyAbleText={depositAddress ?? "---"}
                                    isTable
                                    textColor="text-grey-60 font-medium"
                                    copyIconClassName="size-5 text-grey-60"
                                    checkIconClassName="size-5"
                                    className="p-4 w-full"
                                />
                            </div>

                            <div className="flex items-center w-full justify-between mt-4">
                                <div className="flex items-center gap-2">
                                    <TaoLogo className="size-3 text-grey-10" />
                                    <span className="text-grey-70">Current Tao Price</span>
                                </div>

                                <span>
                                    $
                                    {taoPriceData
                                        ? Number(taoPriceData.price_usd).toFixed(2)
                                        : "---"}{" "}
                                </span>
                            </div>

                            <div className="relative p-2 mt-4 rounded-[8px] border border-primary-50 text-primary-50">
                                <Graphsheet
                                    majorCell={{
                                        lineColor: [31, 80, 189, 1.0],
                                        lineWidth: 2,
                                        cellDim: 35,
                                    }}
                                    minorCell={{
                                        lineColor: [31, 80, 189, 0.5],
                                        lineWidth: 2,
                                        cellDim: 2,
                                    }}
                                    className="w-full absolute top-0 h-full left-0 opacity-15"
                                />

                                <P size="sm" className="flex gap-x-2 relative">
                                    <InfoCircle className="size-6 min-w-6 translate-y-1" />
                                    When you send TAO to the address your wallet is updated at the
                                    rate of $1 to 1 Credit
                                </P>
                            </div>
                        </div>
                    </Tabs.Content>
                </Tabs.Root>
            </div>
        </div>
    );
};

export default TaoTopUp;

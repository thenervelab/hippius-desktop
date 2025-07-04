/* eslint-disable @typescript-eslint/no-explicit-any */
import { Keyring } from "@polkadot/keyring";
import { createWalletClient, http, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  mnemonicToMiniSecret,
  mnemonicGenerate,
  cryptoWaitReady,
  encodeAddress,
  mnemonicValidate,
} from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { hippiusChain } from "./chains";

interface WalletAddresses {
  polkadotAddress: string;
  evmAddress: string;
}

export class WalletManager {
  private evmAccount: ReturnType<typeof privateKeyToAccount> | null = null;
  private walletClient: ReturnType<typeof createWalletClient> | null = null;
  private _polkadotPair: any | null = null;
  private _mnemonic: string | null = null;
  private static wasmInitialized = false;

  get evmWallet() {
    if (!this.evmAccount || !this.walletClient) {
      throw new Error("EVM wallet not initialized");
    }
    return {
      address: this.evmAccount.address,
      signMessage: async (message: string) => {
        return this.walletClient!.signMessage({
          account: this.evmAccount!,
          message,
        });
      },
    };
  }

  get polkadotPair() {
    return this._polkadotPair;
  }

  get mnemonic() {
    return this._mnemonic;
  }

  static async initWasm() {
    if (!this.wasmInitialized) {
      await cryptoWaitReady();
      this.wasmInitialized = true;
    }
  }

  static async generateMnemonic(): Promise<string> {
    await this.initWasm();
    return mnemonicGenerate();
  }

  private async initializeEvmWallet(mnemonic: string) {
    try {
      // Derive private key from mnemonic
      const privateKeyBytes = mnemonicToMiniSecret(mnemonic);
      const privateKey = u8aToHex(privateKeyBytes) as Hex;

      // Create EVM account and wallet client
      this.evmAccount = privateKeyToAccount(privateKey);

      // Create wallet client with fallback transport
      try {
        this.walletClient = createWalletClient({
          account: this.evmAccount,
          chain: hippiusChain,
          transport: http(),
        });
      } catch (error) {
        console.warn(
          "Failed to create wallet client with HTTP transport, proceeding with account only:",
          error
        );
      }

      return this.evmAccount.address;
    } catch (error) {
      console.error("Failed to initialize EVM wallet:", error);
      throw new Error("Failed to initialize EVM wallet");
    }
  }

  async login(mnemonic: string): Promise<WalletAddresses> {
    try {
      // Ensure WASM is initialized
      await WalletManager.initWasm();

      // Validate mnemonic
      const isValidMnemonic = await mnemonicValidate(mnemonic);
      if (!isValidMnemonic) {
        throw new Error("Invalid mnemonic phrase");
      }

      // Store mnemonic
      this._mnemonic = mnemonic;

      // Initialize Polkadot keyring with SS58 format 42
      const keyring = new Keyring({
        type: "sr25519", // Use sr25519 to match Polkadot.js default
        ss58Format: 42,
      });

      // Add from mnemonic with default derivation path
      this._polkadotPair = keyring.addFromUri(mnemonic);

      // Get the address in SS58 format 42
      const polkadotAddress = encodeAddress(this._polkadotPair.addressRaw, 42);

      // Initialize EVM wallet and get address
      const evmAddress = await this.initializeEvmWallet(mnemonic);

      return {
        polkadotAddress,
        evmAddress,
      };
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  async initFromMnemonic(mnemonic: string) {
    // Validate mnemonic first
    if (!mnemonicValidate(mnemonic)) {
      throw new Error(
        "Invalid mnemonic phrase. Please check your access key and try again."
      );
    }

    await WalletManager.initWasm();
    this._mnemonic = mnemonic;

    // Initialize Polkadot wallet
    const keyring = new Keyring({ type: "sr25519" });
    this._polkadotPair = keyring.addFromMnemonic(mnemonic);

    // Initialize EVM wallet
    const miniSecret = mnemonicToMiniSecret(mnemonic);
    const privateKey = u8aToHex(miniSecret);
    this.evmAccount = privateKeyToAccount(privateKey as Hex);
    this.walletClient = createWalletClient({
      account: this.evmAccount,
      chain: hippiusChain,
      transport: http(),
    });

    return {
      polkadotAddress: this._polkadotPair.address,
      evmAddress: this.evmAccount.address,
    };
  }

  clear() {
    this._mnemonic = null;
    this._polkadotPair = null;
    this.evmAccount = null;
    this.walletClient = null;
  }
}

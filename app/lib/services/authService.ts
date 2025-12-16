import { API_CONFIG } from "../config";
import type { OAuthSession } from "@/app/lib/types/oAuth";

export interface ChallengeRequest {
  address: string;
  substrate_address: string;
}

export interface ChallengeResponse {
  challenge: string;
  message: string;
}

export interface AuthResponse {
  token: string;
  user_id: number;
  username: string;
  substrate_address: string;
  is_new: boolean;
}

interface VerifySignatureRequest {
  signature: string;
  address: string;
  substrate_address: string;
  challenge: string;
  referral_code?: string | null;
  session_data?: {
    challenge: string;
    address: string;
  };
}

const OAUTH_SESSION_KEY = "hippius_oauth_session";
const OAUTH_SESSION_EXPIRY_KEY = "hippius_oauth_session_expiry";

class AuthService {
  private baseUrl: string;
  private currentChallenge: string | null = null;
  private currentMessage: string | null = null;
  private currentAddress: string | null = null;

  constructor() {
    this.baseUrl = API_CONFIG.baseUrl || "https://api.hippius.com";
    console.log("[AuthService] Initialized with base URL:", this.baseUrl);
  }

  /**
   * Request authentication challenge
   */
  async requestChallenge(
    address: string,
    substrateAddress: string
  ): Promise<ChallengeResponse> {
    console.log("🔄 [AuthService] Requesting challenge for:", {
      address,
      substrateAddress,
    });

    try {
      const requestBody: ChallengeRequest = {
        address,
        substrate_address: substrateAddress,
      };
      console.log("📤 [AuthService] Challenge request body:", requestBody);

      const response = await fetch(`${this.baseUrl}/api/auth/mnemonic/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: typeof window !== "undefined" ? window.location.origin : "",
          "X-Requested-With": "XMLHttpRequest",
        },
        credentials: "include",
        mode: "cors",
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("❌ [AuthService] Challenge request failed:", {
          status: response.status,
          error,
        });
        throw new Error(`Challenge request failed: ${error}`);
      }

      const data: ChallengeResponse = await response.json();
      this.currentChallenge = data.challenge;
      this.currentMessage = data.message;
      this.currentAddress = address;

      console.log("✅ [AuthService] Challenge response:", {
        challenge: data.challenge,
        message: data.message,
        address: this.currentAddress,
      });

      return data;
    } catch (error) {
      console.error("❌ [AuthService] Challenge request error:", error);
      this.clearState();
      throw error;
    }
  }

  /**
   * Verify signature and get auth token
   */
  async verifySignature(args: {
    signature: string;
    address: string;
    substrateAddress: string;
    referralCode: string | null;
  }): Promise<AuthResponse> {
    const { signature, address, substrateAddress, referralCode } = args;
    console.log("🔄 [AuthService] Starting signature verification");

    try {
      if (
        !this.currentChallenge ||
        !this.currentMessage ||
        !this.currentAddress
      ) {
        console.error("❌ [AuthService] Missing challenge data:", {
          challenge: this.currentChallenge,
          message: this.currentMessage,
          address: this.currentAddress,
        });
        throw new Error("No challenge available. Request a challenge first.");
      }

      // Ensure signature has 0x prefix
      const formattedSignature = signature.startsWith("0x")
        ? signature
        : `0x${signature}`;

      // Prepare request data with session data
      const requestData: VerifySignatureRequest = {
        signature: formattedSignature,
        address,
        substrate_address: substrateAddress,
        challenge: this.currentChallenge,
        referral_code: referralCode || undefined,
        session_data: {
          challenge: this.currentChallenge,
          address: this.currentAddress,
        },
      };

      console.log(
        "📤 [AuthService] Verify request data:",
        JSON.stringify(requestData, null, 2)
      );

      const response = await fetch(`${this.baseUrl}/api/auth/verify/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: typeof window !== "undefined" ? window.location.origin : "",
          "X-Requested-With": "XMLHttpRequest",
        },
        credentials: "include",
        mode: "cors",
        body: JSON.stringify(requestData),
      });

      const responseText = await response.text();
      console.log("📥 [AuthService] Raw verification response:", responseText);

      if (!response.ok) {
        console.error("❌ [AuthService] Verification failed:", {
          status: response.status,
          statusText: response.statusText,
          response: responseText,
        });
        throw new Error(`Signature verification failed: ${responseText}`);
      }

      const data: AuthResponse = JSON.parse(responseText);
      console.log("✅ [AuthService] Verification successful:", data);

      // Store in unified OAuth session storage
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 30); // 30 days like OAuth

      const session: OAuthSession = {
        token: data.token,
        userId: data.user_id,
        username: data.username,
        substrateAddress: data.substrate_address,
        provider: "mnemonic",
        expiresAt: expiry.toISOString(),
        isNew: data.is_new,
      };

      this.storeSession(session);
      console.log(
        "✅ [AuthService] Mnemonic session stored (same format as OAuth)"
      );

      return data;
    } catch (error) {
      console.error("❌ [AuthService] Verification error:", error);
      this.clearState();
      throw error;
    }
  }

  /**
   * Clear internal state
   */
  private clearState(): void {
    console.log("🧹 [AuthService] Clearing state");
    this.currentChallenge = null;
    this.currentMessage = null;
    this.currentAddress = null;
  }

  /**
   * Store session in unified OAuth storage
   */
  private storeSession(session: OAuthSession): void {
    if (typeof window === "undefined") return;

    console.log("[AuthService] Storing session in unified storage");
    localStorage.setItem(OAUTH_SESSION_KEY, JSON.stringify(session));
    localStorage.setItem(OAUTH_SESSION_EXPIRY_KEY, session.expiresAt);
  }

  /**
   * Get current session
   */
  getSession(): OAuthSession | null {
    if (typeof window === "undefined") return null;

    try {
      const sessionData = localStorage.getItem(OAUTH_SESSION_KEY);
      const expiry = localStorage.getItem(OAUTH_SESSION_EXPIRY_KEY);

      if (!sessionData || !expiry) {
        return null;
      }

      // Check if session is expired
      if (new Date(expiry) < new Date()) {
        console.warn("[AuthService] Session expired");
        this.clearSession();
        return null;
      }

      return JSON.parse(sessionData);
    } catch (error) {
      console.error("[AuthService] Failed to retrieve session:", error);
      return null;
    }
  }

  /**
   * Get auth token
   */
  getAuthToken(): string | null {
    const session = this.getSession();
    return session?.token || null;
  }

  /**
   * Check if authenticated
   */
  isAuthenticated(): boolean {
    return this.getSession() !== null;
  }

  /**
   * Clear session
   */
  clearSession(): void {
    if (typeof window === "undefined") return;

    console.log("[AuthService] Clearing session");
    localStorage.removeItem(OAUTH_SESSION_KEY);
    localStorage.removeItem(OAUTH_SESSION_EXPIRY_KEY);
  }

  /**
   * Logout
   */
  logout(): void {
    console.log("[AuthService] Logging out");
    this.clearSession();
  }

  /**
   * Get auth headers
   */
  async getAuthHeaders(): Promise<HeadersInit | null> {
    const session = this.getSession();
    if (!session || !session.token) {
      return null;
    }

    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Authorization: `Token ${session.token}`,
    };
  }
}

export const authService = new AuthService();
export const getAuthHeaders = async () => await authService.getAuthHeaders();

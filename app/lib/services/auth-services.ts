import { API_CONFIG, AUTH_CONFIG } from "../config";

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
  is_new: boolean;
}


class AuthService {
  private baseUrl: string;
  private currentChallenge: string | null = null;
  private currentMessage: string | null = null;
  private currentAddress: string | null = null;

  constructor() {
    this.baseUrl = API_CONFIG.baseUrl;
    console.log("[AuthService] Initialized with base URL:", this.baseUrl);
  }

  private async makeRequest(
    endpoint: string,
    options: RequestInit = {},
    requiresAuth: boolean = false
  ): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;

    // Prepare headers
    const headers = new Headers(options.headers || {});
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    headers.set("Origin", window.location.origin);
    headers.set("X-Requested-With", "XMLHttpRequest");

    // Add auth token if required
    if (requiresAuth) {
      const token = this.getAuthToken();
      if (!token) {
        throw new Error("Authentication required but no token found");
      }
      headers.set("Authorization", `Bearer ${token}`);
    }

    // Log request details
    console.log("🌐 [AuthService] Making request:", {
      url,
      method: options.method || "GET",
      headers: Object.fromEntries(headers.entries()),
      body: options.body ? JSON.parse(options.body as string) : undefined,
      requiresAuth,
    });

    // Make the request
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: "include",
      mode: "cors",
    });

    // Log response details
    console.log("📥 [AuthService] Received response:", {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    });

    // Handle authentication errors
    if (requiresAuth && response.status === 401) {
      console.error("🔒 [AuthService] Authentication failed, clearing token");
      this.removeAuthToken();
      throw new Error("Authentication failed");
    }

    return response;
  }

  public async requestChallenge(
    address: string,
    substrateAddress: string
  ): Promise<ChallengeResponse> {
    console.log("🔄 [AuthService] Requesting challenge for:", {
      address,
      substrateAddress,
    });
    try {
      const requestBody = {
        address,
        substrate_address: substrateAddress,
      };
      console.log("📤 [AuthService] Challenge request body:", requestBody);

      const response = await this.makeRequest(API_CONFIG.auth.mnemonic, {
        method: "POST",
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

      const data = await response.json();
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

  public async verifySignature(args: {
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
      const requestData = {
        signature: formattedSignature,
        address,
        substrate_address: substrateAddress,
        challenge: this.currentChallenge,
        referral_code: referralCode,
        session_data: {
          challenge: this.currentChallenge,
          address: this.currentAddress,
        },
      };

      console.log(
        "📤 [AuthService] Verify request data:",
        JSON.stringify(requestData, null, 2)
      );

      const response = await this.makeRequest(API_CONFIG.auth.verify, {
        method: "POST",
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

      const data = JSON.parse(responseText);
      console.log("✅ [AuthService] Verification successful:", data);

      // Store the auth token
      this.setAuthToken(data.token);

      return data;
    } catch (error) {
      console.error("❌ [AuthService] Verification error:", error);
      this.clearState();
      throw error;
    }
  }

  /**
   * Makes an authenticated request to the API
   * @throws Error if no auth token is found or if authentication fails
   */
  public async makeAuthenticatedRequest(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Response> {
    return this.makeRequest(endpoint, options, true);
  }

  private setAuthToken(token: string): void {
    console.log("🔑 [AuthService] Setting auth token");
    localStorage.setItem(AUTH_CONFIG.tokenStorageKey, token);

    // Set token expiry (24 hours from now)
    const expiry = new Date();
    expiry.setHours(expiry.getHours() + 24);
    localStorage.setItem(AUTH_CONFIG.tokenExpiryKey, expiry.toISOString());
  }

  public getAuthToken(): string | null {
    const token = localStorage.getItem(AUTH_CONFIG.tokenStorageKey);
    const expiry = localStorage.getItem(AUTH_CONFIG.tokenExpiryKey);

    if (!token || !expiry) {
      return null;
    }

    // Check if token is expired
    if (new Date(expiry) < new Date()) {
      console.warn("🕒 [AuthService] Token expired, removing");
      this.removeAuthToken();
      return null;
    }

    return token;
  }

  public isAuthenticated(): boolean {
    return this.getAuthToken() !== null;
  }

  public removeAuthToken(): void {
    console.log("🗑️ [AuthService] Removing auth token");
    localStorage.removeItem(AUTH_CONFIG.tokenStorageKey);
    localStorage.removeItem(AUTH_CONFIG.tokenExpiryKey);
  }

  private clearState(): void {
    console.log("🧹 [AuthService] Clearing state");
    this.currentChallenge = null;
    this.currentMessage = null;
    this.currentAddress = null;
  }

  public logout(): void {
    console.log("🚪 [AuthService] Logging out");
    this.removeAuthToken();
    this.clearState();
  }
}

export const authService = new AuthService();

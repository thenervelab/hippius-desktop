import { getApiAuth, AUTH_CONFIG } from "@/app/lib/helpers/sessionStore";

// Simple auth service for token management
class AuthService {
    private tokenKey = 'auth_token';

    getAuthToken(): string | null {
        if (typeof window === 'undefined') {
            return null;
        }
        return localStorage.getItem(this.tokenKey);
    }

    setAuthToken(token: string): void {
        if (typeof window === 'undefined') {
            return;
        }
        localStorage.setItem(this.tokenKey, token);
    }

    removeAuthToken(): void {
        if (typeof window === 'undefined') {
            return;
        }
        localStorage.removeItem(this.tokenKey);
    }

    isAuthenticated(): boolean {
        return !!this.getAuthToken();
    }

    // New method to get auth headers from session store
    async getAuthHeaders(): Promise<HeadersInit | null> {
        const auth = await getApiAuth();
        if (!auth || !auth.token || (auth.tokenExpiry && auth.tokenExpiry < Date.now())) {
            return null;
        }

        return {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
            Authorization: `${AUTH_CONFIG.tokenScheme} ${auth.token}`,
        };
    }
}

export const authService = new AuthService();
export const getAuthHeaders = async () => await authService.getAuthHeaders();

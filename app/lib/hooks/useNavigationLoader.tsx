import { createContext, useContext, useState, useCallback, useEffect, ReactNode, useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import NProgress from 'nprogress';

// Configure NProgress
NProgress.configure({
    showSpinner: false,
    minimum: 0.1,
    easing: 'ease',
    speed: 300
});

// Context for the navigation loader
interface NavigationLoaderContextType {
    push: (href: string) => void;
    replace: (href: string) => void;
    back: () => void;
    loading: boolean;
}

const NavigationLoaderContext = createContext<NavigationLoaderContextType | undefined>(undefined);

// Provider component
export function NavigationLoaderProvider({ children }: { children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const [loading, setLoading] = useState(false);

    // Complete NProgress when the route changes (page finished loading)
    useEffect(() => {
        if (loading) {
            setLoading(false);
            NProgress.done();
        }
    }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

    // Wrapper for router.push that shows the loader
    const push = useCallback((href: string) => {
        setLoading(true);
        NProgress.start();
        router.push(href);
    }, [router]);

    // Wrapper for router.replace that shows the loader
    const replace = useCallback((href: string) => {
        setLoading(true);
        NProgress.start();
        router.replace(href);
    }, [router]);

    // Wrapper for router.back that shows the loader
    const back = useCallback(() => {
        setLoading(true);
        NProgress.start();
        router.back();
    }, [router]);

    // Context value
    const contextValue = useMemo(() => ({
        push,
        replace,
        back,
        loading
    }), [push, replace, back, loading]);

    return (
        <NavigationLoaderContext.Provider value={contextValue}>
            {children}
        </NavigationLoaderContext.Provider>
    );
}

// Hook to use the navigation loader
export default function useNavigationLoader() {
    const context = useContext(NavigationLoaderContext);

    if (context === undefined) {
        throw new Error('useNavigationLoader must be used within a NavigationLoaderProvider');
    }

    return context;
}


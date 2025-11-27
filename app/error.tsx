'use client';

import { useEffect } from 'react';

export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        // Log the error to console with full details
        console.error('❌ APPLICATION ERROR:', {
            message: error.message,
            stack: error.stack,
            digest: error.digest,
            name: error.name,
            cause: error.cause,
        });

        // Also log to a visible alert for debugging
        if (typeof window !== 'undefined') {
            const errorDetails = `
Error: ${error.message}
Stack: ${error.stack}
Digest: ${error.digest || 'N/A'}
URL: ${window.location.href}
      `.trim();

            console.log('Full error details:', errorDetails);
        }
    }, [error]);

    return (
        <div className="flex items-center justify-center min-h-screen bg-grey-100 p-8">
            <div className="max-w-2xl w-full space-y-6 bg-white rounded-lg shadow-lg p-8">
                <div className="space-y-2">
                    <h2 className="text-2xl font-bold text-error-70">
                        Application Error
                    </h2>
                    <p className="text-grey-40">
                        A client-side exception has occurred
                    </p>
                </div>

                <div className="bg-grey-95 rounded-lg p-4 space-y-2">
                    <div className="text-sm">
                        <span className="font-semibold text-grey-20">Error:</span>
                        <pre className="mt-2 text-xs text-grey-30 overflow-x-auto whitespace-pre-wrap break-words">
                            {error.message}
                        </pre>
                    </div>

                    {error.stack && (
                        <div className="text-sm">
                            <span className="font-semibold text-grey-20">Stack Trace:</span>
                            <pre className="mt-2 text-xs text-grey-30 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                                {error.stack}
                            </pre>
                        </div>
                    )}

                    {error.digest && (
                        <div className="text-sm">
                            <span className="font-semibold text-grey-20">Digest:</span>
                            <pre className="mt-2 text-xs text-grey-30">{error.digest}</pre>
                        </div>
                    )}

                    {typeof window !== 'undefined' && (
                        <div className="text-sm">
                            <span className="font-semibold text-grey-20">Current URL:</span>
                            <pre className="mt-2 text-xs text-grey-30 overflow-x-auto whitespace-pre-wrap break-words">
                                {window.location.href}
                            </pre>
                        </div>
                    )}
                </div>

                <div className="flex gap-4">
                    <button
                        onClick={reset}
                        className="px-4 py-2 bg-primary-50 text-white rounded-lg hover:bg-primary-60 transition-colors"
                    >
                        Try Again
                    </button>
                    <button
                        onClick={() => window.location.href = '/login'}
                        className="px-4 py-2 bg-grey-80 text-grey-20 rounded-lg hover:bg-grey-70 transition-colors"
                    >
                        Go to Login
                    </button>
                </div>

                <div className="text-xs text-grey-50 pt-4 border-t border-grey-90">
                    <p>💡 <strong>Debugging tips:</strong></p>
                    <ul className="list-disc list-inside mt-2 space-y-1">
                        <li>Open DevTools Console (Cmd+Option+I on Mac)</li>
                        <li>Check for red error messages</li>
                        <li>Look for failed network requests in the Network tab</li>
                        <li>Check localStorage and sessionStorage in Application tab</li>
                    </ul>
                </div>
            </div>
        </div>
    );
}

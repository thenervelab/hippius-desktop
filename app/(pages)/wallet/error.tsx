'use client';

import { useEffect } from 'react';

export default function WalletError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Wallet page error:', error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-screen p-8">
      <div className="max-w-md w-full space-y-6 bg-white rounded-lg shadow-lg p-8">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-error-70">
            Wallet Error
          </h2>
          <p className="text-grey-40">
            Something went wrong with the wallet
          </p>
        </div>

        <div className="bg-grey-95 rounded-lg p-4">
          <pre className="text-xs text-grey-30 overflow-x-auto">
            {error.message}
          </pre>
        </div>

        <button
          onClick={reset}
          className="w-full px-4 py-2 bg-primary-50 text-white rounded-lg hover:bg-primary-60 transition-colors"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}

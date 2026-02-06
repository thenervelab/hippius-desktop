'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div className="flex items-center justify-center min-h-screen bg-grey-100 p-8">
          <div className="max-w-2xl w-full space-y-6 bg-white rounded-lg shadow-lg p-8">
            <div className="space-y-2">
              <h2 className="text-2xl font-bold text-red-600">
                Something went wrong!
              </h2>
              <p className="text-grey-600">
                A critical error has occurred
              </p>
            </div>

            <div className="bg-grey-100 rounded-lg p-4">
              <pre className="text-xs text-grey-700 overflow-x-auto">
                {error.message}
              </pre>
            </div>

            <button
              onClick={reset}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

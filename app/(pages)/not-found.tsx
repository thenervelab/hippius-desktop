'use client';

export default function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-grey-10 mb-4">404 - Page Not Found</h2>
        <p className="text-grey-50 mb-6">The page you're looking for doesn't exist.</p>
        <a
          href="/"
          className="px-4 py-2 bg-primary-50 text-white rounded-lg hover:bg-primary-60 transition-colors inline-block"
        >
          Go Home
        </a>
      </div>
    </div>
  );
}

/**
 * The editor's shape while the picture loads: the toolbar, a picture-sized
 * block and the footer, so nothing jumps when it arrives.
 */
export default function EditorSkeleton() {
  const bar = "rounded-[8px] bg-grey-80 dark:bg-black-300 animate-pulse motion-reduce:animate-none";
  return (
    <main
      aria-busy="true"
      aria-label="Opening the screenshot"
      className="flex h-screen flex-col bg-grey-90 dark:bg-black-600"
      data-testid="editor-skeleton"
    >
      <div className="flex items-center gap-1 border-b border-grey-80 bg-white px-3 py-2 dark:border-black-300 dark:bg-black-primary-bg">
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i} className={`size-8 ${bar}`} />
        ))}
      </div>
      <div className="grid min-h-0 flex-1 place-items-center p-6">
        <span className={`aspect-[16/10] w-full max-w-[880px] ${bar}`} />
      </div>
      <div className="flex items-center gap-2 border-t border-grey-80 bg-white px-3 py-2 dark:border-black-300 dark:bg-black-primary-bg">
        <span className={`h-4 w-48 ${bar}`} />
        <span className="flex-1" />
        <span className={`h-8 w-20 ${bar}`} />
        <span className={`h-8 w-20 ${bar}`} />
        <span className={`h-8 w-20 ${bar}`} />
      </div>
    </main>
  );
}

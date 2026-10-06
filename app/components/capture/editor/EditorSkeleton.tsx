/**
 * The editor's shape while it and the picture load: the top row with the
 * pill, a picture-sized block and the zoom pill, on the same dark layer, so
 * nothing jumps when they arrive.
 */
export default function EditorSkeleton() {
  const bar = "bg-black-300 animate-pulse motion-reduce:animate-none";
  return (
    <div
      aria-busy="true"
      aria-label="Opening the picture"
      className="fixed inset-0 z-[1000] flex flex-col bg-black-600"
      data-testid="editor-skeleton"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`size-8 rounded-full ${bar}`} />
        <span className={`h-4 w-40 rounded-full ${bar}`} />
        <span className="flex-1" />
        <span className={`hidden h-10 w-[26rem] rounded-full md:block ${bar}`} />
        <span className="flex-1" />
        <span className={`h-9 w-24 rounded-[10px] ${bar}`} />
        <span className={`h-9 w-20 rounded-[10px] ${bar}`} />
      </div>
      <div className="grid min-h-0 flex-1 place-items-center p-6">
        <span className={`aspect-[16/10] w-full max-w-[880px] rounded-[4px] ${bar}`} />
      </div>
      <div className="flex justify-center pb-4">
        <span className={`h-10 w-40 rounded-full ${bar}`} />
      </div>
    </div>
  );
}

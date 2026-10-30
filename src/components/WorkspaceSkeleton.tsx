// Shown while the visitor's demo copy loads. No product name here: the page shows it once, in the workspace.
export function WorkspaceSkeleton() {
  return (
    <div className="min-h-dvh" aria-busy="true">
      <header className="border-b border-rule bg-sheet">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-8">
          <p className="text-sm text-ink-soft" role="status">
            Loading your demo copy…
          </p>
          <div className="mt-3 h-8 w-64 max-w-full rounded bg-paper" />
          <div className="mt-2 h-4 w-40 rounded bg-paper" />
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="h-96 rounded-md border border-rule bg-sheet" />
        <div className="h-72 rounded-md border border-rule bg-sheet" />
      </div>
    </div>
  );
}

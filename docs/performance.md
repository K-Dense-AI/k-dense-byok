# UI performance boundaries

These optimizations remove redundant work; they do not drop model events or
truncate the user's underlying data.

- **Chat:** `frame-publisher.ts` coalesces only text/thinking display updates to
  animation frames (50 ms timeout fallback for background tabs). Structural and
  terminal frames publish immediately. Stop flushes; reset/unmount cancels pending
  paints. The transcript reducer still consumes every sequenced event. Workspace
  metadata carries `needsInput`, not the entire transcript. Completed message
  rows and tool cards are memoized; notebook-only updates still reach the parent.
- **File previews:** `/sandbox/file` uses async reads and private, revalidated
  metadata ETags (device/inode/size/nanosecond mtime and ctime). Size/not-found
  validation precedes conditional responses. A read changed in place receives no
  validator. Client refreshes share in-flight work, use at most three refresh
  workers, retain unchanged state references, and invalidate outstanding reads on
  save/close/rename. Mutation generations prevent late responses from overwriting
  newer data. Hidden documents stop fast polling and catch up on return. Tree
  ETags are *not* file-content validators.
- **Optional UI:** code views, workflows, the file-preview surface, and settings
  panels are separate dynamic chunks. Settings is loaded on first open and stays
  mounted thereafter so closing/reopening does not discard its state.
- **Scientific previews:** one process-wide queue runs at most two preview jobs.
  Identical requests share work. A consumer disconnect cancels only its interest;
  work is killed when the final consumer disconnects. Success-only LRU caching
  is bounded to 64 entries / 16 MiB / five minutes. Every lookup versions the
  project/path, file metadata, helper script and environment metadata; changed
  inputs during processing are not cached. Image HTTP responses revalidate rather
  than serving a stale five-minute browser entry. Temporary render directories
  are unique and cleaned on every outcome. Metadata validation cannot detect an
  adversary capable of preserving *all* filesystem identity/change metadata.
- **PDF:** only nearby pages retain raster backing pixels. Visited pages retain
  text, annotation overlays, and geometry for selection and navigation. Zoom
  updates those transforms without rasterizing distant pages. This bounds canvas
  residency, not all PDF/text-layer memory. The supported pdfjs 5.x TextLayer
  update API avoids re-extracting text on each zoom.
- **CSV:** tables show at most 250 data rows per page. Search covers the full
  parsed file; Copy full CSV and Download retain the original complete file.
  Browser Find covers the current page, explicitly explained in the toolbar.
  The existing server-side text-preview size limit is unchanged.

## Regression checks

Run both Vitest suites, both TypeScript checks, and a production frontend build.
Tests cover display flushing/cancellation, unchanged message rows, file validators
and stale response races, shared preview cancellation/cache invalidation/queue
limits, PDF canvas eviction with retained text/layout, and full-data CSV search.

Browser checks should use a disposable project: stream a reply and an interview,
switch tabs mid-run, stop a run, edit while an external writer updates the file,
open/close settings and workflows, page/search a large CSV, and scroll/zoom/jump
through a mixed-size multi-page PDF. Check that unchanged file polls return 304,
code-view chunks load only when needed, distant PDF canvases release pixels,
annotations survive eviction, and there are no runtime errors. A deterministic
local OpenAI-compatible test provider can exercise streaming without paid model
calls; it does not validate hosted-provider availability.

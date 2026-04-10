import { sync } from "@/lib/sync";
import { getWorkItems, getReviewItems, getSyncStatus, getAllTags } from "@/lib/db";
import { getApiCallStats, getRecentApiCalls } from "@/lib/cache";

export async function GET(request: Request) {
  const bypass = new URL(request.url).searchParams.get("fresh") === "1";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function emit(done: boolean, step: number, totalSteps: number, result: { viewerLogin: string; rateLimits: Record<string, unknown>; errors: string[] }) {
        const items = getWorkItems();
        const reviewItems = getReviewItems();
        const allTags = getAllTags();
        const line = JSON.stringify({
          viewerLogin: result.viewerLogin,
          items,
          reviewItems,
          allTags,
          rateLimits: result.rateLimits,
          errors: [...result.errors],
          stats: getApiCallStats(),
          recent: getRecentApiCalls(100),
          progress: { step, totalSteps },
          done,
        });
        controller.enqueue(encoder.encode(line + "\n"));
      }

      // Partial result to track accumulated state across progress callbacks
      const partialResult = { viewerLogin: "", rateLimits: {} as Record<string, unknown>, errors: [] as string[] };

      // Restore viewerLogin from sync_status
      const ghStatus = getSyncStatus("github_reviews");
      if (ghStatus?.meta && typeof ghStatus.meta === "object" && "viewerLogin" in ghStatus.meta) {
        partialResult.viewerLogin = ghStatus.meta.viewerLogin as string;
      }

      // Phase 0: Emit current DB state immediately
      emit(false, 0, 10, partialResult);

      const result = await sync({
        force: bypass,
        onProgress: ({ step, totalSteps }) => {
          emit(false, step, totalSteps, partialResult);
        },
      });

      partialResult.viewerLogin = result.viewerLogin;
      partialResult.rateLimits = result.rateLimits;
      partialResult.errors = result.errors;
      emit(true, 10, 10, partialResult);
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    },
  });
}

import { syncCompleted } from "@/lib/completed-sync";
import { getCompletedWorkItems } from "@/lib/db";

export async function GET(request: Request) {
  const bypass = new URL(request.url).searchParams.get("fresh") === "1";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function emit(done: boolean, step: number, totalSteps: number, errors: string[]) {
        const items = getCompletedWorkItems();
        const line = JSON.stringify({
          items,
          errors: [...errors],
          progress: { step, totalSteps },
          done,
        });
        controller.enqueue(encoder.encode(line + "\n"));
      }

      // Phase 0: emit current DB state immediately (stale-while-revalidate)
      emit(false, 0, 3, []);

      const result = await syncCompleted({
        force: bypass,
        onProgress: ({ step, totalSteps }) => {
          emit(false, step, totalSteps, []);
        },
      });

      emit(true, 3, 3, result.errors);
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

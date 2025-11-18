import type { SupabaseClient } from "@supabase/supabase-js";
import type { CaptureEntryRow, Database } from "../types.ts";

export type ChunkRecord = {
  start: Date;
  end: Date;
  late?: boolean;
  overlapped?: boolean;
  prime?: boolean;
};

export async function replaceCaptureChunks(
  admin: SupabaseClient<Database, "public">,
  capture: CaptureEntryRow,
  chunks: ChunkRecord[],
) {
  await admin.from("capture_chunks").delete().eq("capture_id", capture.id);
  if (chunks.length === 0) return;

  const rows = chunks.map((chunk) => ({
    capture_id: capture.id,
    start: chunk.start.toISOString(),
    end: chunk.end.toISOString(),
    late: chunk.late ?? false,
    overlapped: chunk.overlapped ?? false,
    prime: chunk.prime ?? true,
  }));

  const { error } = await admin.from("capture_chunks").insert(rows);
  if (error) {
    console.error("replaceCaptureChunks insert error", { captureId: capture.id, error });
  }
}

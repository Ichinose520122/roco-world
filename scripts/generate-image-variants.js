import { Buffer } from "node:buffer";
import { config } from "../server/config.js";
import { D1Database } from "../server/db.js";
import { LocalGalleryBucket } from "../server/storage.js";
import { ensureSchema, listRows } from "../functions/_lib/db.js";
import {
  createImageVariants,
  variantObjectKey,
} from "../functions/_lib/image-variants.js";

const argumentsList = process.argv.slice(2);
const force = argumentsList.includes("--force");
const limitArgument = argumentsList.find((argument) => argument.startsWith("--limit="));
const limit = limitArgument
  ? Math.max(1, Math.min(100_000, Number(limitArgument.split("=")[1]) || 1))
  : Number.POSITIVE_INFINITY;

const db = new D1Database(config.dbPath);
const bucket = new LocalGalleryBucket(config.storageRoot);

let generated = 0;
let skipped = 0;
let failed = 0;

try {
  await ensureSchema(db);
  const rows = (await listRows(db, true)).slice(0, limit);
  console.log(`准备检查 ${rows.length} 张图片；force=${force}`);

  for (const [index, row] of rows.entries()) {
    const thumbnailKey = variantObjectKey(row.object_key, "thumbnail");
    const previewKey = variantObjectKey(row.object_key, "preview");
    const [existingThumbnail, existingPreview] = await Promise.all([
      bucket.get(thumbnailKey),
      bucket.get(previewKey),
    ]);
    if (!force && existingThumbnail && existingPreview) {
      skipped += 1;
      continue;
    }

    try {
      const original = await bucket.get(row.object_key);
      if (!original) throw new Error(`原图不存在：${row.object_key}`);
      const input = Buffer.from(await new Response(original.body).arrayBuffer());
      const variants = await createImageVariants(input);

      if (force || !existingThumbnail) {
        await bucket.put(thumbnailKey, variants.thumbnail.buffer, {
          httpMetadata: { contentType: "image/webp" },
          customMetadata: { galleryId: row.id, variant: "thumbnail", managedBy: "backfill" },
        });
      }
      if (force || !existingPreview) {
        await bucket.put(previewKey, variants.preview.buffer, {
          httpMetadata: { contentType: "image/webp" },
          customMetadata: { galleryId: row.id, variant: "preview", managedBy: "backfill" },
        });
      }
      generated += 1;
      console.log(`[${index + 1}/${rows.length}] 已生成：${row.id}`);
    } catch (error) {
      failed += 1;
      console.error(`[${index + 1}/${rows.length}] 失败：${row.id}：${error.message}`);
    }
  }
} finally {
  db.close();
}

console.log(`处理完成：生成 ${generated}，跳过 ${skipped}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;

import { listCategories, normalizeCategoryId } from "../../_lib/categories.js";
import {
  adminItem,
  ensureSchema,
  invalidatePublicGalleryCache,
  writePrivateGallerySnapshot,
} from "../../_lib/db.js";
import {
  apiError,
  cleanText,
  json,
  normalizeTags,
  requireSameOrigin,
  validOptionalDateTime,
  validShotTime,
} from "../../_lib/http.js";
import {
  createImageVariants,
  variantObjectKey,
} from "../../_lib/image-variants.js";

const EXTENSIONS = Object.freeze({
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/avif": "avif",
  "image/gif": "gif",
});

export async function onRequestPost(context) {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const storedKeys = [];
  try {
    await ensureSchema(context.env.DB);
    const form = await context.request.formData();
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") return apiError("请选择图片");
    const refreshSnapshot = form.get("refreshSnapshot") !== "false";

    const contentType = String(file.type || "").toLowerCase();
    const extension = EXTENSIONS[contentType];
    if (!extension) return apiError("仅支持 WebP、JPEG、PNG、AVIF 或 GIF 图片");
    const maxBytes = Number(context.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
    if (!file.size || file.size > maxBytes) return apiError("图片为空或超过上传大小限制");

    const category = await normalizeCategoryId(context.env.DB, cleanText(form.get("category"), 80));
    const shotAt = validShotTime(form.get("time"));
    if (!category) return apiError("分类无效");
    if (!shotAt) return apiError("截图时间格式无效");

    const pinnedEnabled = form.get("pinnedEnabled") === "true";
    const featuredEnabled = form.get("featuredEnabled") === "true";
    const pinnedUntil = validOptionalDateTime(form.get("pinnedUntil"));
    const featuredUntil = validOptionalDateTime(form.get("featuredUntil"));
    if (pinnedUntil === undefined || featuredUntil === undefined) {
      return apiError("置顶或加精时间格式无效");
    }

    const id = crypto.randomUUID();
    const objectKey = `gallery/${id}.${extension}`;
    const original = Buffer.from(await file.arrayBuffer());
    const variants = await createImageVariants(original);
    const thumbnailKey = variantObjectKey(objectKey, "thumbnail");
    const previewKey = variantObjectKey(objectKey, "preview");

    await context.env.GALLERY_BUCKET.put(objectKey, original, {
      httpMetadata: { contentType },
      customMetadata: { galleryId: id, managedBy: "gallery-admin" },
    });
    storedKeys.push(objectKey);
    await context.env.GALLERY_BUCKET.put(thumbnailKey, variants.thumbnail.buffer, {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: {
        galleryId: id,
        managedBy: "gallery-admin",
        variant: "thumbnail",
      },
    });
    storedKeys.push(thumbnailKey);
    await context.env.GALLERY_BUCKET.put(previewKey, variants.preview.buffer, {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: {
        galleryId: id,
        managedBy: "gallery-admin",
        variant: "preview",
      },
    });
    storedKeys.push(previewKey);

    const now = new Date().toISOString();
    await context.env.DB.prepare(
      `INSERT INTO gallery_items (
        id, object_key, category, title, comment, shot_at, tags_json,
        content_type, size, is_pinned, pinned_until, is_featured, featured_until,
        created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
      .bind(
        id,
        objectKey,
        category,
        cleanText(form.get("title"), 160),
        cleanText(form.get("comment"), 2000),
        shotAt,
        JSON.stringify(normalizeTags(form.get("tags"))),
        contentType,
        file.size,
        pinnedEnabled ? 1 : 0,
        pinnedEnabled ? pinnedUntil : null,
        featuredEnabled ? 1 : 0,
        featuredEnabled ? featuredUntil : null,
        now,
        now,
      )
      .run();

    if (refreshSnapshot) {
      await writePrivateGallerySnapshot(context.env);
      await invalidatePublicGalleryCache(context);
    }
    if (form.get("minimalResponse") === "true") {
      return json({ ok: true, id }, { status: 201 });
    }
    const row = await context.env.DB.prepare("SELECT * FROM gallery_items WHERE id = ?1")
      .bind(id)
      .first();
    const categories = await listCategories(context.env.DB);
    return json({ ok: true, image: adminItem(row, categories) }, { status: 201 });
  } catch (error) {
    console.error(error);
    await Promise.all(storedKeys.map((key) =>
      context.env.GALLERY_BUCKET.delete(key).catch(() => {})));
    return apiError("上传失败", 500);
  }
}

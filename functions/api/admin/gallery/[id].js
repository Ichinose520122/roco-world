import { findCategoryInList, listCategories } from "../../../_lib/categories.js";
import {
  adminItem,
  ensureSchema,
  invalidateGalleryDerivedData,
  setSetting,
} from "../../../_lib/db.js";
import {
  apiError,
  cleanText,
  json,
  normalizeTags,
  requireSameOrigin,
  validOptionalDateTime,
  validShotTime,
} from "../../../_lib/http.js";
import { variantObjectKey } from "../../../_lib/image-variants.js";

export async function onRequestPatch(context) {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  try {
    await ensureSchema(context.env.DB);
    const id = String(context.params.id || "");
    const current = await context.env.DB.prepare("SELECT * FROM gallery_items WHERE id = ?1")
      .bind(id)
      .first();
    if (!current) return apiError("图片不存在", 404);

    const body = await context.request.json();
    const categories = await listCategories(context.env.DB);
    const categoryDefinition = findCategoryInList(
      categories,
      cleanText(body.category ?? current.category, 80),
    );
    const category = categoryDefinition?.id || null;
    const shotAt = validShotTime(body.time ?? current.shot_at);
    if (!category) return apiError("分类无效");
    if (!shotAt) return apiError("截图时间格式无效");

    const pinnedEnabled = body.pinnedEnabled === undefined
      ? Boolean(current.is_pinned)
      : Boolean(body.pinnedEnabled);
    const featuredEnabled = body.featuredEnabled === undefined
      ? Boolean(current.is_featured)
      : Boolean(body.featuredEnabled);
    const pinnedUntil = validOptionalDateTime(body.pinnedUntil ?? current.pinned_until);
    const featuredUntil = validOptionalDateTime(body.featuredUntil ?? current.featured_until);
    if (pinnedUntil === undefined || featuredUntil === undefined) {
      return apiError("置顶或加精时间格式无效");
    }

    const title = cleanText(body.title ?? current.title, 160);
    const comment = cleanText(body.comment ?? current.comment, 2000);
    const tagsJson = JSON.stringify(normalizeTags(
      body.tags ?? JSON.parse(current.tags_json || "[]"),
    ));
    const storedPinnedUntil = pinnedEnabled ? pinnedUntil : null;
    const storedFeaturedUntil = featuredEnabled ? featuredUntil : null;
    const now = new Date().toISOString();
    await context.env.DB.prepare(
      `UPDATE gallery_items SET
        category = ?1,
        title = ?2,
        comment = ?3,
        shot_at = ?4,
        tags_json = ?5,
        is_pinned = ?6,
        pinned_until = ?7,
        is_featured = ?8,
        featured_until = ?9,
        updated_at = ?10
       WHERE id = ?11`,
    )
      .bind(
        category,
        title,
        comment,
        shotAt,
        tagsJson,
        pinnedEnabled ? 1 : 0,
        storedPinnedUntil,
        featuredEnabled ? 1 : 0,
        storedFeaturedUntil,
        now,
        id,
      )
      .run();

    await invalidateGalleryDerivedData(context);
    const updated = {
      ...current,
      category,
      title,
      comment,
      shot_at: shotAt,
      tags_json: tagsJson,
      is_pinned: pinnedEnabled ? 1 : 0,
      pinned_until: storedPinnedUntil,
      is_featured: featuredEnabled ? 1 : 0,
      featured_until: storedFeaturedUntil,
      updated_at: now,
    };
    const imageUrl = new URL(`/gallery/${encodeURIComponent(id)}?download=1`, context.request.url);
    context.waitUntil(caches.default.delete(new Request(imageUrl.toString())));
    return json({ ok: true, image: adminItem(updated, categories) });
  } catch (error) {
    console.error(error);
    return apiError("保存失败", 500);
  }
}

export async function onRequestDelete(context) {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  try {
    await ensureSchema(context.env.DB);
    const id = String(context.params.id || "");
    const current = await context.env.DB.prepare(
      "SELECT id, object_key FROM gallery_items WHERE id = ?1",
    )
      .bind(id)
      .first();
    if (!current) return apiError("图片不存在", 404);

    const objectKeys = [
      current.object_key,
      variantObjectKey(current.object_key, "thumbnail"),
      variantObjectKey(current.object_key, "preview"),
    ];
    await context.env.DB.batch([
      context.env.DB.prepare("DELETE FROM photo_comments WHERE image_id = ?1").bind(id),
      context.env.DB.prepare("DELETE FROM gallery_items WHERE id = ?1").bind(id),
    ]);
    const heroSetting = await context.env.DB.prepare(
      "SELECT value FROM gallery_settings WHERE key = 'hero_image_id'",
    ).first();
    if (heroSetting?.value === id) await setSetting(context.env.DB, "hero_image_id", "");
    await invalidateGalleryDerivedData(context);
    const deletionResults = await Promise.allSettled(
      objectKeys.map((key) => context.env.GALLERY_BUCKET.delete(key)),
    );
    deletionResults.forEach((result, index) => {
      if (result.status === "rejected") {
        console.warn(`图片索引已删除，但文件清理失败：${objectKeys[index]}`, result.reason);
      }
    });
    const imageUrl = new URL(`/gallery/${encodeURIComponent(id)}`, context.request.url);
    const downloadUrl = new URL(imageUrl.toString());
    downloadUrl.searchParams.set("download", "1");
    const thumbnailUrl = new URL(imageUrl.toString());
    thumbnailUrl.searchParams.set("variant", "thumbnail");
    const previewUrl = new URL(imageUrl.toString());
    previewUrl.searchParams.set("variant", "preview");
    context.waitUntil(Promise.all([
      caches.default.delete(new Request(imageUrl.toString())),
      caches.default.delete(new Request(downloadUrl.toString())),
      caches.default.delete(new Request(thumbnailUrl.toString())),
      caches.default.delete(new Request(previewUrl.toString())),
    ]));
    return json({ ok: true, deletedId: id });
  } catch (error) {
    console.error(error);
    return apiError("删除失败", 500);
  }
}

import { ensureSchema } from "../../_lib/db.js";
import { apiError, json, requireSameOrigin } from "../../_lib/http.js";

function adminComment(row) {
  return {
    id: String(row.id),
    imageId: String(row.image_id),
    imageUrl: `/gallery/${encodeURIComponent(row.image_id)}?variant=thumbnail`,
    imageTitle: row.image_title || "未命名瞬间",
    imageTime: row.shot_at,
    categoryName: row.category_name || "未分组",
    authorName: String(row.author_name),
    content: String(row.content),
    read: Boolean(row.is_read),
    createdAt: String(row.created_at),
  };
}

async function commentCounts(db) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total,
      SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
     FROM photo_comments`,
  ).first();
  return { total: Number(row?.total || 0), unreadCount: Number(row?.unread || 0) };
}

export async function onRequestGet(context) {
  try {
    await ensureSchema(context.env.DB);
    const summaryOnly = new URL(context.request.url).searchParams.get("summary") === "1";
    if (summaryOnly) {
      const unreadRow = await context.env.DB.prepare(
        "SELECT COUNT(*) AS unread FROM photo_comments WHERE is_read = 0",
      ).first();
      return json({
        ok: true,
        unreadCount: Number(unreadRow?.unread || 0),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const counts = await commentCounts(context.env.DB);
    const rows = await context.env.DB.prepare(
      `SELECT
         c.*,
         i.title AS image_title,
         i.shot_at,
         g.name AS category_name
       FROM photo_comments c
       JOIN gallery_items i ON i.id = c.image_id
       LEFT JOIN gallery_categories g ON g.id = i.category
       ORDER BY c.is_read ASC, c.created_at DESC, c.id DESC
       LIMIT 300`,
    ).all();
    return json({
      ok: true,
      ...counts,
      comments: (rows.results || []).map(adminComment),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(error);
    return apiError("无法读取留言", 503);
  }
}

export async function onRequestPost(context) {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  try {
    await ensureSchema(context.env.DB);
    const body = await context.request.json();
    if (body.action !== "mark-all-read") return apiError("留言操作无效");
    const now = new Date().toISOString();
    const result = await context.env.DB.prepare(
      "UPDATE photo_comments SET is_read = 1, updated_at = ?1 WHERE is_read = 0",
    ).bind(now).run();
    return json({ ok: true, changed: Number(result.meta?.changes || 0), unreadCount: 0 });
  } catch (error) {
    console.error(error);
    return apiError("更新留言状态失败", 500);
  }
}

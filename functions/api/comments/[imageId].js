import { ensureSchema } from "../../_lib/db.js";
import { getFriendSession } from "../../_lib/friends.js";
import { apiError, cleanText, json, requireSameOrigin } from "../../_lib/http.js";

function publicComment(row) {
  return {
    id: String(row.id),
    authorName: String(row.author_name),
    authorVerified: Boolean(row.author_verified),
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}

async function findImage(db, imageId) {
  return db.prepare("SELECT id FROM gallery_items WHERE id = ?1").bind(imageId).first();
}

export async function onRequestGet(context) {
  try {
    await ensureSchema(context.env.DB);
    const imageId = String(context.params.imageId || "");
    if (!await findImage(context.env.DB, imageId)) return apiError("照片不存在", 404);
    const rows = await context.env.DB.prepare(
      `SELECT c.id, c.author_name, c.content, c.created_at,
        COALESCE(f.is_verified, 0) AS author_verified,
        COUNT(*) OVER () AS total_count
       FROM photo_comments c
       LEFT JOIN gallery_friends f ON f.id = c.friend_id
       WHERE c.image_id = ?1
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT 100`,
    ).bind(imageId).all();
    return json({
      ok: true,
      imageId,
      total: Number(rows.results?.[0]?.total_count || 0),
      comments: (rows.results || []).map(publicComment),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(error);
    return apiError("留言暂时无法读取", 503);
  }
}

export async function onRequestPost(context) {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  try {
    await ensureSchema(context.env.DB);
    const imageId = String(context.params.imageId || "");
    if (!await findImage(context.env.DB, imageId)) return apiError("照片不存在", 404);
    const session = await getFriendSession(context);
    if (!session) return apiError("请先使用好友身份登录", 401);

    const body = await context.request.json();
    const content = cleanText(body.content, 500);
    if (!content) return apiError("请输入留言内容");
    if (content.length < 2) return apiError("留言内容太短了");

    const nowDate = new Date();
    const now = nowDate.toISOString();
    const oneMinuteAgo = new Date(nowDate.getTime() - 60 * 1000).toISOString();
    const oneDayAgo = new Date(nowDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const limits = await context.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END) AS minute_count,
         COUNT(*) AS day_count
       FROM photo_comments
       WHERE friend_id = ?1 AND created_at >= ?3`,
    ).bind(session.friend.id, oneMinuteAgo, oneDayAgo).first();
    if (Number(limits?.minute_count || 0) >= 3) {
      return apiError("留言太快啦，请稍后再试", 429);
    }
    if (Number(limits?.day_count || 0) >= 50) {
      return apiError("今天的留言数量已经达到上限", 429);
    }

    const duplicate = await context.env.DB.prepare(
      `SELECT id FROM photo_comments
       WHERE friend_id = ?1 AND image_id = ?2 AND content = ?3 AND created_at >= ?4`,
    ).bind(session.friend.id, imageId, content, oneMinuteAgo).first();
    if (duplicate) return apiError("这条留言刚刚已经发表过了", 409);

    const id = `comment-${crypto.randomUUID()}`;
    await context.env.DB.prepare(
      `INSERT INTO photo_comments
        (id, image_id, friend_id, author_name, content, is_read, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)`,
    ).bind(id, imageId, session.friend.id, session.friend.displayName, content, now, now).run();
    const row = {
      id,
      author_name: session.friend.displayName,
      author_verified: session.friend.verified ? 1 : 0,
      content,
      created_at: now,
    };
    const galleryUrl = new URL("/api/gallery", context.request.url);
    context.waitUntil(caches.default.delete(new Request(galleryUrl.toString())));
    return json({ ok: true, comment: publicComment(row) }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(error);
    return apiError("发表留言失败，请稍后再试", 500);
  }
}

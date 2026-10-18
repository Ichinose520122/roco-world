import { ensureSchema } from "../../_lib/db.js";
import {
  friendAuthIsConfigured,
  hashStudentId,
  normalizeFriendName,
} from "../../_lib/friends.js";
import { apiError, cleanText, json, requireSameOrigin } from "../../_lib/http.js";

function adminFriend(row) {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    active: Boolean(row.is_active),
    verified: Boolean(row.is_verified),
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at,
    commentCount: Number(row.comment_count || 0),
    activeSessions: Number(row.active_sessions || 0),
  };
}

export async function onRequestGet(context) {
  try {
    await ensureSchema(context.env.DB);
    const now = new Date().toISOString();
    const rows = await context.env.DB.prepare(
      `SELECT
         f.*,
         (SELECT COUNT(*) FROM photo_comments c WHERE c.friend_id = f.id) AS comment_count,
         (SELECT COUNT(*) FROM friend_sessions s
          WHERE s.friend_id = f.id AND s.expires_at > ?1) AS active_sessions
       FROM gallery_friends f
       ORDER BY f.is_verified ASC, f.is_active DESC, f.display_name COLLATE NOCASE ASC, f.created_at ASC`,
    ).bind(now).all();
    return json({
      ok: true,
      configured: friendAuthIsConfigured(context.env),
      friends: (rows.results || []).map(adminFriend),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(error);
    return apiError("无法读取好友名单", 503);
  }
}

export async function onRequestPost(context) {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  try {
    await ensureSchema(context.env.DB);
    const body = await context.request.json();
    const displayName = cleanText(body.displayName, 40);
    const studentId = cleanText(body.studentId, 80);
    if (!displayName || !studentId) return apiError("请填写游戏名称和学号");
    const normalizedName = normalizeFriendName(displayName);
    const studentIdHmac = await hashStudentId(studentId, context.env);
    const exists = await context.env.DB.prepare(
      "SELECT id FROM gallery_friends WHERE student_id_hmac = ?1",
    ).bind(studentIdHmac).first();
    if (exists) return apiError("这个学号已经在好友名单中", 409);

    const id = `friend-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await context.env.DB.prepare(
      `INSERT INTO gallery_friends
        (id, display_name, normalized_name, student_id_hmac, is_active, is_verified, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?6)`,
    ).bind(id, displayName, normalizedName, studentIdHmac, now, now).run();
    const row = {
      id,
      display_name: displayName,
      is_active: 1,
      is_verified: 1,
      last_login_at: null,
      created_at: now,
      comment_count: 0,
      active_sessions: 0,
    };
    return json({ ok: true, friend: adminFriend(row) }, { status: 201 });
  } catch (error) {
    console.error(error);
    const unavailable = String(error.message || "").includes("FRIEND_ID_SECRET");
    return apiError(unavailable ? error.message : "添加好友失败", unavailable ? 503 : 500);
  }
}

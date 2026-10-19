import { ensureSchema } from "../../../_lib/db.js";
import { hashStudentId, normalizeFriendName } from "../../../_lib/friends.js";
import { apiError, cleanText, json, requireSameOrigin } from "../../../_lib/http.js";

export async function onRequestPatch(context) {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  try {
    await ensureSchema(context.env.DB);
    const id = String(context.params.id || "");
    const current = await context.env.DB.prepare(
      "SELECT * FROM gallery_friends WHERE id = ?1",
    ).bind(id).first();
    if (!current) return apiError("好友不存在", 404);

    const body = await context.request.json();
    const displayName = body.displayName === undefined
      ? current.display_name
      : cleanText(body.displayName, 40);
    if (!displayName) return apiError("游戏名称不能为空");
    const active = body.active === undefined ? Boolean(current.is_active) : Boolean(body.active);
    if (body.verified !== undefined && typeof body.verified !== "boolean") {
      return apiError("认证状态无效");
    }
    const verified = body.verified === undefined ? Boolean(current.is_verified) : body.verified;
    const newStudentId = cleanText(body.studentId, 80);
    const studentIdHmac = newStudentId
      ? await hashStudentId(newStudentId, context.env)
      : current.student_id_hmac;
    if (newStudentId) {
      const duplicate = await context.env.DB.prepare(
        "SELECT id, normalized_name, is_verified FROM gallery_friends WHERE student_id_hmac = ?1 AND id <> ?2",
      ).bind(studentIdHmac, id).first();
      if (duplicate && !duplicate.is_verified
        && duplicate.normalized_name === normalizeFriendName(displayName)) {
        return apiError("这个学号已被同名待认证身份使用，它不是当前好友账号；请先处理该身份，或换一个未使用的新学号", 409);
      }
      if (duplicate) return apiError("这个学号已经属于另一位好友", 409);
    }

    const studentIdChanged = studentIdHmac !== current.student_id_hmac;
    const now = new Date().toISOString();
    const result = await context.env.DB.prepare(
      `UPDATE gallery_friends SET
         display_name = ?1,
         normalized_name = ?2,
         student_id_hmac = ?3,
         is_active = ?4,
         is_verified = ?5,
         updated_at = ?6
       WHERE id = ?7`,
    ).bind(
      displayName,
      normalizeFriendName(displayName),
      studentIdHmac,
      active ? 1 : 0,
      verified ? 1 : 0,
      now,
      id,
    ).run();
    if (Number(result.meta?.changes) !== 1) {
      return apiError("好友资料未更新，请刷新后台后重试", 409);
    }
    const saved = await context.env.DB.prepare(
      "SELECT display_name, normalized_name, student_id_hmac, is_active, is_verified FROM gallery_friends WHERE id = ?1",
    ).bind(id).first();
    if (!saved
      || saved.display_name !== displayName
      || saved.normalized_name !== normalizeFriendName(displayName)
      || saved.student_id_hmac !== studentIdHmac
      || Boolean(saved.is_active) !== active
      || Boolean(saved.is_verified) !== verified) {
      return apiError("好友资料保存校验失败，请刷新后台后重试", 500);
    }
    if (!active || studentIdChanged || body.revokeSessions === true) {
      await context.env.DB.prepare("DELETE FROM friend_sessions WHERE friend_id = ?1")
        .bind(id)
        .run();
    }
    const galleryUrl = new URL("/api/gallery", context.request.url);
    await caches.default.delete(new Request(galleryUrl.toString()));
    return json({ ok: true, friendId: id, studentIdChanged });
  } catch (error) {
    console.error(error);
    const unavailable = String(error.message || "").includes("FRIEND_ID_SECRET");
    return apiError(unavailable ? error.message : "保存好友失败", unavailable ? 503 : 500);
  }
}

export async function onRequestDelete(context) {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  try {
    await ensureSchema(context.env.DB);
    const id = String(context.params.id || "");
    const current = await context.env.DB.prepare(
      "SELECT id FROM gallery_friends WHERE id = ?1",
    ).bind(id).first();
    if (!current) return apiError("好友不存在", 404);
    await context.env.DB.batch([
      context.env.DB.prepare(
        "UPDATE photo_comments SET friend_id = NULL WHERE friend_id = ?1",
      ).bind(id),
      context.env.DB.prepare("DELETE FROM friend_sessions WHERE friend_id = ?1").bind(id),
      context.env.DB.prepare("DELETE FROM gallery_friends WHERE id = ?1").bind(id),
    ]);
    const galleryUrl = new URL("/api/gallery", context.request.url);
    await caches.default.delete(new Request(galleryUrl.toString()));
    return json({ ok: true, deletedId: id });
  } catch (error) {
    console.error(error);
    return apiError("删除好友失败", 500);
  }
}

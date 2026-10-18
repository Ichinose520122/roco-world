import { ensureSchema } from "../../_lib/db.js";
import {
  clearFriendCookie,
  clearLoginFailures,
  createFriendSession,
  deleteCurrentFriendSession,
  getFriendSession,
  hasFriendSessionCookie,
  hashLoginIdentity,
  hashStudentId,
  loginIsBlocked,
  normalizeFriendName,
  publicFriend,
  recordLoginFailure,
} from "../../_lib/friends.js";
import { apiError, cleanText, json, requireSameOrigin } from "../../_lib/http.js";

export async function onRequestGet(context) {
  try {
    if (!hasFriendSessionCookie(context.request)) {
      return json({
        ok: true,
        authenticated: false,
        friend: null,
        expiresAt: null,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    await ensureSchema(context.env.DB);
    const session = await getFriendSession(context);
    return json({
      ok: true,
      authenticated: Boolean(session),
      friend: publicFriend(session?.friend),
      expiresAt: session?.expiresAt || null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(error);
    return apiError("好友登录服务暂时不可用", 503);
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
    if (!displayName || !studentId) return apiError("请输入游戏 ID 和学号");

    const identityHash = await hashLoginIdentity(context.request, context.env);
    if (await loginIsBlocked(context.env.DB, identityHash)) {
      return apiError("尝试次数过多，请稍后再试", 429);
    }

    const normalizedName = normalizeFriendName(displayName);
    const studentIdHmac = await hashStudentId(studentId, context.env);
    let friend = await context.env.DB.prepare(
      `SELECT id, display_name, normalized_name, is_active, is_verified
       FROM gallery_friends WHERE student_id_hmac = ?1`,
    ).bind(studentIdHmac).first();
    if (friend && (friend.normalized_name !== normalizedName || !friend.is_active)) {
      await recordLoginFailure(context.env.DB, identityHash);
      return apiError("ID 与学号不匹配，或该身份已被停用", 401);
    }

    const now = new Date().toISOString();
    if (!friend) {
      // Count new identities as attempts too, to limit public registration abuse.
      await recordLoginFailure(context.env.DB, identityHash);
      await context.env.DB.prepare(
        `INSERT INTO gallery_friends
          (id, display_name, normalized_name, student_id_hmac, is_active, is_verified, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?5)
         ON CONFLICT(student_id_hmac) DO NOTHING`,
      ).bind(`friend-${crypto.randomUUID()}`, displayName, normalizedName, studentIdHmac, now).run();
      friend = await context.env.DB.prepare(
        "SELECT id, display_name, normalized_name, is_active, is_verified FROM gallery_friends WHERE student_id_hmac = ?1",
      ).bind(studentIdHmac).first();
      if (!friend || friend.normalized_name !== normalizedName || !friend.is_active) {
        return apiError("ID 与学号不匹配，或该身份已被停用", 401);
      }
    } else if (friend.is_verified) {
      await clearLoginFailures(context.env.DB, identityHash);
    }
    await context.env.DB.prepare(
      "UPDATE gallery_friends SET last_login_at = ?1, updated_at = ?2 WHERE id = ?3",
    ).bind(now, now, friend.id).run();
    const session = await createFriendSession(context, friend.id);
    context.waitUntil(context.env.DB.prepare(
      "DELETE FROM friend_sessions WHERE expires_at <= ?1",
    ).bind(now).run());

    return json({
      ok: true,
      authenticated: true,
      friend: publicFriend({ id: friend.id, displayName: friend.display_name, verified: Boolean(friend.is_verified) }),
      expiresAt: session.expiresAt,
    }, {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": session.cookie,
      },
    });
  } catch (error) {
    console.error(error);
    const unavailable = String(error.message || "").includes("FRIEND_ID_SECRET");
    return apiError(unavailable ? error.message : "登录失败，请稍后再试", unavailable ? 503 : 500);
  }
}

export async function onRequestDelete(context) {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  try {
    await ensureSchema(context.env.DB);
    await deleteCurrentFriendSession(context);
    return json({ ok: true, authenticated: false, friend: null }, {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": clearFriendCookie(context.request),
      },
    });
  } catch (error) {
    console.error(error);
    return apiError("退出登录失败", 500);
  }
}

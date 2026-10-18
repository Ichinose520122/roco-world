const COOKIE_NAME = "roco_friend_session";
const DEFAULT_SESSION_DAYS = 30;

const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  new Uint8Array(bytes).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function friendAuthIsConfigured(env) {
  return String(env.FRIEND_ID_SECRET || "").length >= 16;
}

function getAuthSecret(env) {
  if (!friendAuthIsConfigured(env)) {
    throw new Error(
      "好友登录尚未配置：请在 VPS 的 .env 中添加 FRIEND_ID_SECRET（建议至少 32 位随机值）",
    );
  }
  return String(env.FRIEND_ID_SECRET);
}

async function hmac(value, env) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getAuthSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export function normalizeFriendName(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
}

export function normalizeStudentId(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

export async function hashStudentId(value, env) {
  const normalized = normalizeStudentId(value);
  if (!normalized) return "";
  return hmac(`student-id:${normalized}`, env);
}

export async function hashLoginIdentity(request, env) {
  const forwardedFor = request.headers.get("X-Forwarded-For") || "";
  const ip = request.headers.get("CF-Connecting-IP")
    || forwardedFor.split(",")[0]?.trim()
    || request.headers.get("X-Real-IP")
    || "unknown";
  return hmac(`login-ip:${ip}`, env);
}

export async function hashSessionToken(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(String(value || ""))));
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

export function hasFriendSessionCookie(request) {
  return Boolean(readCookie(request, COOKIE_NAME));
}

function sessionDays(env) {
  const value = Number(env.FRIEND_SESSION_DAYS || DEFAULT_SESSION_DAYS);
  return Number.isFinite(value) ? Math.max(1, Math.min(90, Math.round(value))) : DEFAULT_SESSION_DAYS;
}

function secureCookieAttribute(request) {
  const hostname = new URL(request.url).hostname;
  return ["localhost", "127.0.0.1"].includes(hostname) ? "" : "; Secure";
}

export function clearFriendCookie(request) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieAttribute(request)}`;
}

export async function createFriendSession(context, friendId) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(tokenBytes);
  const tokenHash = await hashSessionToken(token);
  const now = new Date();
  const maxAge = sessionDays(context.env) * 24 * 60 * 60;
  const expiresAt = new Date(now.getTime() + maxAge * 1000).toISOString();
  await context.env.DB.prepare(
    `INSERT INTO friend_sessions
      (token_hash, friend_id, expires_at, last_used_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(tokenHash, friendId, expiresAt, now.toISOString(), now.toISOString()).run();
  return {
    cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookieAttribute(context.request)}`,
    expiresAt,
  };
}

export async function deleteCurrentFriendSession(context) {
  const token = readCookie(context.request, COOKIE_NAME);
  if (!token) return;
  const tokenHash = await hashSessionToken(token);
  await context.env.DB.prepare("DELETE FROM friend_sessions WHERE token_hash = ?1")
    .bind(tokenHash)
    .run();
}

export async function getFriendSession(context) {
  const token = readCookie(context.request, COOKIE_NAME);
  if (!token) return null;
  const tokenHash = await hashSessionToken(token);
  const now = new Date().toISOString();
  const row = await context.env.DB.prepare(
    `SELECT
       s.token_hash,
       s.expires_at,
       s.last_used_at,
       f.id AS friend_id,
       f.display_name,
       f.is_verified
     FROM friend_sessions s
     JOIN gallery_friends f ON f.id = s.friend_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND f.is_active = 1`,
  ).bind(tokenHash, now).first();
  if (!row) return null;

  const lastUsed = Date.parse(row.last_used_at || "");
  if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > 12 * 60 * 60 * 1000) {
    context.waitUntil(context.env.DB.prepare(
      "UPDATE friend_sessions SET last_used_at = ?1 WHERE token_hash = ?2",
    ).bind(now, tokenHash).run());
  }
  return {
    tokenHash,
    expiresAt: row.expires_at,
    friend: { id: row.friend_id, displayName: row.display_name, verified: Boolean(row.is_verified) },
  };
}

export function publicFriend(friend) {
  return friend ? { id: String(friend.id), displayName: String(friend.displayName), verified: friend.verified === true } : null;
}

export async function loginIsBlocked(db, identityHash) {
  const now = new Date().toISOString();
  const row = await db.prepare(
    "SELECT blocked_until FROM friend_login_attempts WHERE identity_hash = ?1",
  ).bind(identityHash).first();
  return Boolean(row?.blocked_until && row.blocked_until > now);
}

export async function recordLoginFailure(db, identityHash) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const row = await db.prepare(
    "SELECT attempts, window_started_at FROM friend_login_attempts WHERE identity_hash = ?1",
  ).bind(identityHash).first();
  const withinWindow = row?.window_started_at
    && nowDate.getTime() - Date.parse(row.window_started_at) < 15 * 60 * 1000;
  const attempts = withinWindow ? Number(row.attempts || 0) + 1 : 1;
  const windowStartedAt = withinWindow ? row.window_started_at : now;
  const blockedUntil = attempts >= 8
    ? new Date(nowDate.getTime() + 30 * 60 * 1000).toISOString()
    : null;
  await db.prepare(
    `INSERT INTO friend_login_attempts
      (identity_hash, attempts, window_started_at, blocked_until, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(identity_hash) DO UPDATE SET
       attempts = excluded.attempts,
       window_started_at = excluded.window_started_at,
       blocked_until = excluded.blocked_until,
       updated_at = excluded.updated_at`,
  ).bind(identityHash, attempts, windowStartedAt, blockedUntil, now).run();
}

export async function clearLoginFailures(db, identityHash) {
  await db.prepare("DELETE FROM friend_login_attempts WHERE identity_hash = ?1")
    .bind(identityHash)
    .run();
}

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { D1Database } from "../server/db.js";
import { installCache } from "../server/cache.js";
import { ensureSchema } from "../functions/_lib/db.js";
import { hashSessionToken, hashStudentId } from "../functions/_lib/friends.js";
import { createRouter } from "../server/routes.js";

test("legacy identities survive upgrade; public commenters require owner verification", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roco-friends-"));
  const db = new D1Database(resolve(root, "gallery.sqlite"));
  const env = { DB: db, FRIEND_ID_SECRET: "test-secret-that-is-long-enough" };
  installCache({ maxBytes: 4 * 1024 * 1024, maxObjectBytes: 1024 * 1024 });
  try {
    // Model the old database, including its schema-version marker and live cookie.
    for (const name of ["0001_gallery", "0002_categories", "0003_settings", "0004_friends_comments", "0005_performance"]) {
      db.raw.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8"));
    }
    const now = new Date().toISOString();
    db.raw.prepare("INSERT OR REPLACE INTO gallery_settings VALUES ('runtime_schema_version', '2026-07-performance-v1', ?)").run(now);
    db.raw.prepare(`INSERT INTO gallery_friends
      (id, display_name, normalized_name, student_id_hmac, created_at, updated_at)
      VALUES ('legacy', '老好友', '老好友', ?, ?, ?)`)
      .run(await hashStudentId("old-123", env), now, now);
    db.raw.prepare(`INSERT INTO friend_sessions VALUES (?, 'legacy', ?, ?, ?)`)
      .run(await hashSessionToken("old-cookie"), "2099-01-01T00:00:00.000Z", now, now);
    db.raw.prepare(`INSERT INTO gallery_items
      (id, object_key, category, shot_at, created_at, updated_at)
      VALUES ('photo', 'photo.webp', 'lovely-ringo', ?, ?, ?)`)
      .run(now, now, now);
    db.raw.prepare(`INSERT INTO photo_comments
      (id, image_id, friend_id, author_name, content, created_at, updated_at)
      VALUES ('old-comment', 'photo', 'legacy', '老好友', '旧留言保留', ?, ?)`)
      .run(now, now);

    await ensureSchema(db);
    const router = await createRouter();
    const call = async (path, method = "GET", body, cookie) => {
      const response = await router.dispatch(new Request(`http://localhost${path}`, {
        method,
        headers: { Origin: "http://localhost", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), env);
      return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
    };
    const oldSession = await call("/api/friend/session", "GET", null, "roco_friend_session=old-cookie");
    assert.equal(oldSession.body.friend.verified, true);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM photo_comments").get().n, 1);
    assert.equal((await call("/api/friend/session", "POST", { displayName: "老好友", studentId: "old-123" })).body.friend.verified, true);

    const credentials = { displayName: "新好友", studentId: "new-456", verified: true };
    const login = await call("/api/friend/session", "POST", credentials);
    assert.equal(login.status, 200);
    assert.equal(login.body.friend.verified, false); // Ignore client-supplied trust.
    const id = login.body.friend.id;
    const repeated = await call("/api/friend/session", "POST", credentials);
    assert.equal(repeated.body.friend.id, id);
    const wrongStudentId = await call("/api/friend/session", "POST", { displayName: "新好友", studentId: "wrong-student-id" });
    assert.equal(wrongStudentId.status, 401);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM gallery_friends").get().n, 2);
    assert.equal((await call("/api/friend/session", "POST", { ...credentials, displayName: "冒名" })).status, 401);
    assert.equal((await call("/api/friend/session", "POST", { displayName: "缺少学号" })).status, 400);
    const comment = await call("/api/comments/photo", "POST", { content: "新好友可以留言", authorVerified: true }, login.cookie);
    assert.equal(comment.status, 201);
    assert.equal(comment.body.comment.authorVerified, false);
    assert.equal((await call("/api/comments/photo", "POST", { content: "未登录" })).status, 401);
    assert.equal((await call("/api/comments/photo", "POST", { content: "新好友可以留言" }, login.cookie)).status, 409);
    const gallery = await call("/api/gallery");
    assert.equal(gallery.status, 200);
    assert.equal(JSON.stringify(gallery.body).includes('"authorVerified":false'), true);
    const adminFriends = await call("/api/admin/friends");
    assert.equal(adminFriends.body.friends[0].id, id);
    assert.equal(JSON.stringify(adminFriends.body).includes("student_id_hmac"), false);

    assert.equal((await call(`/api/admin/friends/${id}`, "PATCH", { verified: true })).status, 200);
    assert.equal((await call("/api/friend/session", "GET", null, login.cookie)).body.friend.verified, true);
    const verifiedComments = await call("/api/comments/photo");
    assert.equal(verifiedComments.body.comments.find((c) => c.id === comment.body.comment.id).authorVerified, true);
    assert.equal(JSON.stringify((await call("/api/gallery")).body).includes('"authorVerified":false'), false);
    assert.equal((await call("/api/admin/comments")).body.comments.every((c) => c.authorVerified), true);

    await call(`/api/admin/friends/${id}`, "PATCH", { verified: false });
    assert.equal((await call("/api/friend/session", "GET", null, login.cookie)).body.friend.verified, false);
    const updated = await call(`/api/admin/friends/${id}`, "PATCH", { displayName: "新好友", studentId: "000520123", active: true, verified: true });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.studentIdChanged, true);
    assert.equal(db.raw.prepare("SELECT student_id_hmac FROM gallery_friends WHERE id = ?").get(id).student_id_hmac, await hashStudentId("000520123", env));
    assert.equal((await call("/api/friend/session", "GET", null, login.cookie)).body.authenticated, false);
    const replacement = await call("/api/friend/session", "POST", { displayName: "新好友", studentId: "000520123" });
    assert.equal(replacement.status, 200);
    assert.equal(replacement.body.friend.id, id);
    assert.equal(replacement.body.friend.verified, true);
    assert.equal((await call(`/api/admin/friends/${id}`, "PATCH", { studentId: "０００５２０１２３" })).body.studentIdChanged, false);
    assert.equal((await call(`/api/admin/friends/${id}`, "PATCH", { studentId: "" })).body.studentIdChanged, false);
    assert.equal((await call("/api/friend/session", "GET", null, replacement.cookie)).body.authenticated, true);
    assert.equal((await call("/api/friend/session", "POST", { displayName: "新好友", studentId: "new-456" })).status, 401);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM gallery_friends").get().n, 2);
    await call(`/api/admin/friends/${id}`, "PATCH", { active: false });
    assert.equal((await call("/api/friend/session", "POST", { displayName: "新好友", studentId: "000520123" })).status, 401);
    assert.equal((await call("/api/comments/photo", "POST", { content: "停用后留言" }, replacement.cookie)).status, 401);
    assert.equal((await call(`/api/admin/friends/${id}`, "DELETE")).status, 200);
    assert.equal((await call("/api/comments/photo")).body.total, 2);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM gallery_friends").get().n, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("student ID edits cannot report success when the database skips or overrides the write", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roco-student-write-"));
  const db = new D1Database(resolve(root, "gallery.sqlite"));
  const env = { DB: db, FRIEND_ID_SECRET: "test-secret-that-is-long-enough" };
  installCache({ maxBytes: 1024 * 1024, maxObjectBytes: 1024 * 1024 });
  try {
    await ensureSchema(db);
    const router = await createRouter();
    const call = async (path, method, body, cookie) => {
      const response = await router.dispatch(new Request(`http://localhost${path}`, {
        method,
        headers: { Origin: "http://localhost", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), env);
      return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
    };
    const created = await call("/api/admin/friends", "POST", { displayName: "测试好友", studentId: "00123456" });
    const id = created.body.friend.id;
    const login = await call("/api/friend/session", "POST", { displayName: "测试好友", studentId: "00123456" });
    // Preserve a duplicate identity created by the previous public login flow.
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO gallery_friends
      (id, display_name, normalized_name, student_id_hmac, is_active, is_verified, created_at, updated_at)
      VALUES ('legacy-pending', '测试好友', '测试好友', ?1, 1, 0, ?2, ?2)`)
      .bind(await hashStudentId("pending-student-id", env), now).run();
    const occupied = await call(`/api/admin/friends/${id}`, "PATCH", { studentId: "pending-student-id" });
    assert.equal(occupied.status, 409);
    assert.match(occupied.body.error, /同名待认证/);
    assert.equal((await call("/api/friend/session", "GET", null, login.cookie)).body.authenticated, true);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM gallery_friends").get().n, 2);
    // A skipped SQLite write is not an error, but changes is zero.
    db.raw.exec(`CREATE TRIGGER ignore_student_id_update BEFORE UPDATE OF student_id_hmac
      ON gallery_friends BEGIN SELECT RAISE(IGNORE); END`);
    const skipped = await call(`/api/admin/friends/${id}`, "PATCH", { studentId: "000520123" });
    assert.equal(skipped.status, 409);
    assert.equal(skipped.body.ok, false);
    assert.match(skipped.body.error, /未更新/);
    assert.equal((await call("/api/friend/session", "GET", null, login.cookie)).body.authenticated, true);
    assert.equal((await call("/api/friend/session", "POST", { displayName: "测试好友", studentId: "00123456" })).body.friend.id, id);
    db.raw.exec("DROP TRIGGER ignore_student_id_update");
    // Verify the stored data as well, even when changes reports one row.
    db.raw.exec(`CREATE TRIGGER override_student_id_update AFTER UPDATE OF student_id_hmac
      ON gallery_friends BEGIN
        UPDATE gallery_friends SET student_id_hmac = 'unexpected-value' WHERE id = NEW.id;
      END`);
    const overridden = await call(`/api/admin/friends/${id}`, "PATCH", { studentId: "000520123" });
    assert.equal(overridden.status, 500);
    assert.equal(overridden.body.ok, false);
    assert.match(overridden.body.error, /保存校验失败/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

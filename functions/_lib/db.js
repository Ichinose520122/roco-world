import {
  DEFAULT_CATEGORIES,
  findCategoryInList,
  listCategories,
} from "./categories.js";

const initialized = new WeakMap();
const RUNTIME_SCHEMA_VERSION = "2026-07-performance-v1";

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS gallery_items (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  shot_at TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  content_type TEXT NOT NULL DEFAULT 'image/webp',
  size INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  pinned_until TEXT,
  is_featured INTEGER NOT NULL DEFAULT 0,
  featured_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CATEGORIES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS gallery_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CATEGORY_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS gallery_items_category_idx ON gallery_items(category, shot_at DESC)";
const CATEGORY_ORDER_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS gallery_categories_order_idx ON gallery_categories(sort_order, created_at)";
const SCHEDULE_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS gallery_items_schedule_idx ON gallery_items(is_pinned, pinned_until, is_featured, featured_until)";
const SNAPSHOT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS gallery_snapshots (
  name TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
const SETTINGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS gallery_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
const FRIENDS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS gallery_friends (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  student_id_hmac TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
const FRIEND_SESSIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS friend_sessions (
  token_hash TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (friend_id) REFERENCES gallery_friends(id) ON DELETE CASCADE
)`;
const COMMENTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS photo_comments (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  friend_id TEXT,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (image_id) REFERENCES gallery_items(id) ON DELETE CASCADE,
  FOREIGN KEY (friend_id) REFERENCES gallery_friends(id) ON DELETE SET NULL
)`;
const LOGIN_ATTEMPTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS friend_login_attempts (
  identity_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
)`;
const FRIEND_NAME_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS gallery_friends_name_idx ON gallery_friends(normalized_name, is_active)";
const FRIEND_SESSION_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS friend_sessions_friend_idx ON friend_sessions(friend_id, expires_at)";
const FRIEND_SESSION_EXPIRES_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS friend_sessions_expires_idx ON friend_sessions(expires_at)";
const COMMENT_IMAGE_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS photo_comments_image_idx ON photo_comments(image_id, created_at DESC)";
const COMMENT_UNREAD_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS photo_comments_unread_idx ON photo_comments(is_read, created_at DESC)";
const COMMENT_FRIEND_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS photo_comments_friend_created_idx ON photo_comments(friend_id, created_at DESC)";

async function schemaIsCurrent(db) {
  try {
    const row = await db.prepare(
      "SELECT value FROM gallery_settings WHERE key = 'runtime_schema_version'",
    ).first();
    return row?.value === RUNTIME_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

async function initializeSchema(db) {
  if (await schemaIsCurrent(db)) return;

  await db.batch([
    db.prepare(TABLE_SQL),
    db.prepare(CATEGORIES_TABLE_SQL),
    db.prepare(CATEGORY_INDEX_SQL),
    db.prepare(CATEGORY_ORDER_INDEX_SQL),
    db.prepare(SCHEDULE_INDEX_SQL),
    db.prepare(SNAPSHOT_TABLE_SQL),
    db.prepare(SETTINGS_TABLE_SQL),
    db.prepare(FRIENDS_TABLE_SQL),
    db.prepare(FRIEND_SESSIONS_TABLE_SQL),
    db.prepare(COMMENTS_TABLE_SQL),
    db.prepare(LOGIN_ATTEMPTS_TABLE_SQL),
    db.prepare(FRIEND_NAME_INDEX_SQL),
    db.prepare(FRIEND_SESSION_INDEX_SQL),
    db.prepare(FRIEND_SESSION_EXPIRES_INDEX_SQL),
    db.prepare(COMMENT_IMAGE_INDEX_SQL),
    db.prepare(COMMENT_UNREAD_INDEX_SQL),
    db.prepare(COMMENT_FRIEND_INDEX_SQL),
  ]);

  const now = new Date().toISOString();
  await db.batch(DEFAULT_CATEGORIES.map((category, index) => db.prepare(
    `INSERT OR IGNORE INTO gallery_categories
      (id, name, aliases_json, sort_order, is_visible, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)`,
  ).bind(
    category.id,
    category.name,
    JSON.stringify(category.aliases),
    (index + 1) * 10,
    now,
    now,
  )));

  await db.batch(DEFAULT_CATEGORIES.map((category) => {
    const legacyValues = [category.name, ...category.aliases];
    const placeholders = legacyValues.map((_, index) => `?${index + 2}`).join(", ");
    return db.prepare(
      `UPDATE gallery_items
       SET category = ?1
       WHERE category <> ?1 AND category IN (${placeholders})`,
    ).bind(category.id, ...legacyValues);
  }));

  const versionedAt = new Date().toISOString();
  await db.prepare(
    `INSERT INTO gallery_settings (key, value, updated_at)
     VALUES ('runtime_schema_version', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(RUNTIME_SCHEMA_VERSION, versionedAt).run();
}

export async function ensureSchema(db) {
  if (!db) throw new Error("数据库尚未初始化，请检查 VPS 的 DB_PATH 与 data 目录权限。");
  if (!initialized.has(db)) {
    const initialization = initializeSchema(db).catch((error) => {
      initialized.delete(db);
      throw error;
    });
    initialized.set(db, initialization);
  }
  await initialized.get(db);
}

export function safeTags(tagsJson) {
  try {
    const value = JSON.parse(tagsJson || "[]");
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

export function scheduleIsActive(enabled, until, now = new Date()) {
  if (!enabled) return false;
  if (!until) return true;
  const current = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  return String(until) > current;
}

export function publicItem(row, now = new Date(), options = {}) {
  const imageUrl = `/gallery/${encodeURIComponent(row.id)}`;
  const item = {
    id: row.id,
    title: row.title || "",
    comment: row.comment || "",
    time: row.shot_at,
    tags: safeTags(row.tags_json),
    pinned: scheduleIsActive(row.is_pinned, row.pinned_until, now),
    featured: scheduleIsActive(row.is_featured, row.featured_until, now),
    url: imageUrl,
    thumbnailUrl: `${imageUrl}?variant=thumbnail`,
    previewUrl: `${imageUrl}?variant=preview`,
  };
  if (options.category) {
    item.categoryId = options.category.id;
    item.categoryName = options.category.name;
  }
  if (options.commentInfo) {
    item.friendCommentCount = Number(options.commentInfo.count || 0);
    item.friendComments = options.commentInfo.items || [];
  }
  return item;
}

export function adminItem(row, categories, now = new Date()) {
  const category = findCategoryInList(categories, row.category);
  return {
    ...publicItem(row, now),
    categoryId: category?.id || row.category,
    category: category?.id || row.category,
    categoryName: category?.name || "未分组",
    pinnedEnabled: Boolean(row.is_pinned),
    pinnedUntil: row.pinned_until || null,
    featuredEnabled: Boolean(row.is_featured),
    featuredUntil: row.featured_until || null,
    contentType: row.content_type,
    size: Number(row.size || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRows(db, includeObjectKey = false) {
  const fields = [
    "id",
    "category",
    "title",
    "comment",
    "shot_at",
    "tags_json",
    "content_type",
    "size",
    "is_pinned",
    "pinned_until",
    "is_featured",
    "featured_until",
    "created_at",
    "updated_at",
  ];
  if (includeObjectKey) fields.push("object_key");
  const result = await db
    .prepare(`SELECT ${fields.join(", ")} FROM gallery_items ORDER BY shot_at DESC, id DESC`)
    .all();
  return result.results || [];
}

export async function listPublicCommentSummaries(db, perImage = 2) {
  const limit = Math.max(1, Math.min(3, Number(perImage) || 2));
  const result = await db.prepare(
    `SELECT image_id, id, author_name, content, created_at, total_count
     FROM (
       SELECT
         image_id,
         id,
         author_name,
         content,
         created_at,
         COUNT(*) OVER (PARTITION BY image_id) AS total_count,
         ROW_NUMBER() OVER (
           PARTITION BY image_id ORDER BY created_at DESC, id DESC
         ) AS row_number
       FROM photo_comments
     )
     WHERE row_number <= ?1
     ORDER BY image_id ASC, created_at DESC, id DESC`,
  ).bind(limit).all();

  const summaries = new Map();
  (result.results || []).forEach((row) => {
    if (!summaries.has(row.image_id)) {
      summaries.set(row.image_id, { count: Number(row.total_count || 0), items: [] });
    }
    summaries.get(row.image_id).items.push({
      id: String(row.id),
      authorName: String(row.author_name),
      content: String(row.content),
      createdAt: String(row.created_at),
    });
  });
  return summaries;
}

export async function getSetting(db, key) {
  const row = await db.prepare(
    "SELECT value FROM gallery_settings WHERE key = ?1",
  ).bind(String(key)).first();
  return row?.value ? String(row.value) : "";
}

export async function getSettings(db, keys) {
  const normalizedKeys = [...new Set((keys || []).map(String).filter(Boolean))];
  if (!normalizedKeys.length) return {};
  const placeholders = normalizedKeys.map((_, index) => `?${index + 1}`).join(", ");
  const result = await db.prepare(
    `SELECT key, value FROM gallery_settings WHERE key IN (${placeholders})`,
  ).bind(...normalizedKeys).all();
  return Object.fromEntries(
    (result.results || []).map((row) => [String(row.key), String(row.value)]),
  );
}

export async function setSetting(db, key, value) {
  const normalizedKey = String(key);
  const normalizedValue = String(value || "");
  if (!normalizedValue) {
    await db.prepare("DELETE FROM gallery_settings WHERE key = ?1")
      .bind(normalizedKey)
      .run();
    return "";
  }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO gallery_settings (key, value, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(normalizedKey, normalizedValue, now).run();
  return normalizedValue;
}

export async function writePrivateGallerySnapshot(env) {
  const [rows, categories, settings] = await Promise.all([
    listRows(env.DB, true),
    listCategories(env.DB),
    getSettings(env.DB, ["hero_image_id", "hero_mode", "recent_limit"]),
  ]);
  const heroImageId = settings.hero_image_id || "";
  const heroMode = settings.hero_mode || "";
  const recentLimit = settings.recent_limit || "";
  const snapshot = {
    version: 4,
    updatedAt: new Date().toISOString(),
    settings: {
      heroImageId,
      heroMode: ["manual", "featured", "all"].includes(heroMode) ? heroMode : "manual",
      recentLimit: [30, 50, 100].includes(Number(recentLimit)) ? Number(recentLimit) : 30,
    },
    categories: categories.map(({ id, name, sortOrder, visible }) => ({
      id,
      name,
      sortOrder,
      visible,
    })),
    images: rows.map((row) => {
      const category = findCategoryInList(categories, row.category);
      return {
        id: row.id,
        objectKey: row.object_key,
        category: category?.id || row.category,
        categoryName: category?.name || "未分组",
        title: row.title || "",
        comment: row.comment || "",
        time: row.shot_at,
        tags: safeTags(row.tags_json),
        contentType: row.content_type,
        size: Number(row.size || 0),
        pinned: { enabled: Boolean(row.is_pinned), until: row.pinned_until || null },
        featured: { enabled: Boolean(row.is_featured), until: row.featured_until || null },
      };
    }),
  };

  await env.DB.prepare(
    `INSERT INTO gallery_snapshots (name, payload, updated_at)
     VALUES ('gallery.json', ?1, ?2)
     ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(snapshot, null, 2), snapshot.updatedAt)
    .run();
  return snapshot;
}

export async function invalidatePrivateGallerySnapshot(env) {
  await env.DB.prepare(
    "DELETE FROM gallery_snapshots WHERE name = 'gallery.json'",
  ).run();
}

export function publicGalleryCacheKey(request) {
  const requestUrl = new URL(request.url);
  return new Request(new URL("/api/gallery", requestUrl.origin).toString(), { method: "GET" });
}

export async function readPublicGalleryCache(request) {
  try {
    return await caches.default.match(publicGalleryCacheKey(request));
  } catch {
    return null;
  }
}

export function storePublicGalleryCache(context, response) {
  context.waitUntil((async () => {
    try {
      await caches.default.put(publicGalleryCacheKey(context.request), response.clone());
    } catch (error) {
      console.warn("Public gallery cache write skipped", error);
    }
  })());
}

export async function invalidatePublicGalleryCache(context) {
  try {
    return await caches.default.delete(publicGalleryCacheKey(context.request));
  } catch (error) {
    console.warn("Public gallery cache invalidation skipped", error);
    return false;
  }
}

export async function invalidateGalleryDerivedData(context) {
  await Promise.all([
    invalidatePrivateGallerySnapshot(context.env),
    invalidatePublicGalleryCache(context),
  ]);
}

export function buildPublicGallery(rows, categories, options = {}) {
  const now = new Date();
  const grouped = new Map(categories.map((category) => [category.id, []]));
  const visibleEntries = [];

  rows.forEach((row) => {
    const category = findCategoryInList(categories, row.category);
    if (!category) return;
    const item = publicItem(row, now, {
      category,
      commentInfo: options.commentSummaries?.get(row.id) || { count: 0, items: [] },
    });
    grouped.get(category.id).push(item);
    visibleEntries.push({ row, item });
  });

  const sortItems = (a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return Date.parse(b.time.replace(" ", "T")) - Date.parse(a.time.replace(" ", "T"));
  };

  const recentLimit = [30, 50, 100].includes(Number(options.recentLimit))
    ? Number(options.recentLimit)
    : 30;
  const recentImages = visibleEntries
    .sort((a, b) => {
      const delta = Date.parse(b.row.created_at || "") - Date.parse(a.row.created_at || "");
      if (Number.isFinite(delta) && delta !== 0) return delta;
      return String(b.row.id).localeCompare(String(a.row.id));
    })
    .slice(0, recentLimit)
    .map((entry) => entry.item);

  return {
    version: 4,
    generatedAt: now.toISOString(),
    categories: [
      { id: "recent-updates", name: "最近更新", virtual: true, images: recentImages },
      ...categories.map((category) => ({
        id: category.id,
        name: category.name,
        images: (grouped.get(category.id) || []).sort(sortItems),
      })),
    ],
  };
}

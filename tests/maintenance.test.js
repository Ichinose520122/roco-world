import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import sharp from "sharp";

sharp.cache(false);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runScript(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    encoding: "utf8",
  });
}

test("D1 import and backup scripts preserve database and image data", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roco-vps-maintenance-"));
  const databasePath = resolve(root, "gallery.sqlite");
  const storageRoot = resolve(root, "images");
  const backupRoot = resolve(root, "backups");
  const exportPath = resolve(root, "d1-export.sql");
  const migrations = [
    "0001_gallery.sql",
    "0002_categories.sql",
    "0003_settings.sql",
    "0004_friends_comments.sql",
    "0005_performance.sql",
  ].map((file) => readFileSync(resolve(ROOT, "migrations", file), "utf8")).join("\n");
  writeFileSync(exportPath, `${migrations}
INSERT INTO gallery_items (
  id, object_key, category, title, comment, shot_at, tags_json,
  content_type, size, is_pinned, pinned_until, is_featured, featured_until,
  created_at, updated_at
) VALUES (
  'test-image-1234', 'gallery/test-image-1234.webp', 'ringo',
  '', '', '2026-07-23 12:00:00', '[]', 'image/webp', 4,
  0, NULL, 0, NULL, '2026-07-23T12:00:00.000Z', '2026-07-23T12:00:00.000Z'
);
`, "utf8");

  const env = {
    DATA_DIR: root,
    DB_PATH: databasePath,
    STORAGE_ROOT: storageRoot,
    BACKUP_DIR: backupRoot,
  };

  try {
    const imported = runScript("scripts/import-d1.js", [exportPath], env);
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);

    const database = new DatabaseSync(databasePath);
    try {
      const row = database.prepare(
        "SELECT object_key FROM gallery_items WHERE id = ?",
      ).get("test-image-1234");
      assert.equal(row.object_key, "gallery/test-image-1234.webp");
    } finally {
      database.close();
    }

    mkdirSync(resolve(storageRoot, "gallery"), { recursive: true });
    writeFileSync(resolve(storageRoot, "gallery", "test-image-1234.webp"), "RIFF");

    const backedUp = runScript("scripts/backup.js", [], env);
    assert.equal(backedUp.status, 0, backedUp.stderr || backedUp.stdout);
    const backups = readdirSync(backupRoot);
    assert.equal(backups.length, 1);
    const destination = resolve(backupRoot, backups[0]);
    assert.equal(
      readFileSync(resolve(destination, "images", "gallery", "test-image-1234.webp"), "utf8"),
      "RIFF",
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("image backfill creates clear variants and index reset preserves friends", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roco-vps-images-"));
  const databasePath = resolve(root, "gallery.sqlite");
  const storageRoot = resolve(root, "images");
  const backupRoot = resolve(root, "backups");
  const env = {
    DATA_DIR: root,
    DB_PATH: databasePath,
    STORAGE_ROOT: storageRoot,
    BACKUP_DIR: backupRoot,
  };

  try {
    const database = new DatabaseSync(databasePath);
    const migrations = [
      "0001_gallery.sql",
      "0002_categories.sql",
      "0003_settings.sql",
      "0004_friends_comments.sql",
      "0005_performance.sql",
    ].map((file) => readFileSync(resolve(ROOT, "migrations", file), "utf8")).join("\n");
    database.exec(migrations);
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO gallery_items (
      id, object_key, category, title, comment, shot_at, tags_json,
      content_type, size, is_pinned, pinned_until, is_featured, featured_until,
      created_at, updated_at
    ) VALUES (?, ?, ?, '', '', ?, '[]', 'image/webp', 0, 0, NULL, 0, NULL, ?, ?)`)
      .run("variant-test-1234", "gallery/variant-test-1234.webp", "lovely-ringo",
        "2026-08-04 12:00:00", now, now);
    database.prepare(`INSERT INTO gallery_friends (
      id, display_name, normalized_name, student_id_hmac, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run("friend-test", "测试好友", "测试好友", "test-hmac", now, now);
    database.close();

    const galleryDirectory = resolve(storageRoot, "gallery");
    mkdirSync(galleryDirectory, { recursive: true });
    await sharp({
      create: {
        width: 3840,
        height: 2160,
        channels: 3,
        background: { r: 100, g: 149, b: 237 },
      },
    }).webp({ quality: 80 }).toFile(resolve(galleryDirectory, "variant-test-1234.webp"));

    const backfill = runScript("scripts/generate-image-variants.js", [], env);
    assert.equal(backfill.status, 0, backfill.stderr || backfill.stdout);
    const thumbnailPath = resolve(galleryDirectory, "variant-test-1234.thumbnail.webp");
    const previewPath = resolve(galleryDirectory, "variant-test-1234.preview.webp");
    assert.equal(existsSync(thumbnailPath), true);
    assert.equal(existsSync(previewPath), true);
    const thumbnail = await sharp(thumbnailPath).metadata();
    const preview = await sharp(previewPath).metadata();
    assert.equal(thumbnail.width, 1024);
    assert.equal(thumbnail.height, 576);
    assert.equal(preview.width, 2048);
    assert.equal(preview.height, 1152);

    const dryRun = runScript("scripts/reset-gallery-index.js", [], env);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const confirmed = runScript("scripts/reset-gallery-index.js", ["--confirm"], env);
    assert.equal(confirmed.status, 0, confirmed.stderr || confirmed.stdout);

    const verified = new DatabaseSync(databasePath);
    try {
      assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM gallery_items").get().count, 0);
      assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM gallery_friends").get().count, 1);
    } finally {
      verified.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { installCache } from "../server/cache.js";
import { D1Database } from "../server/db.js";
import { createRouter } from "../server/routes.js";
import { LocalGalleryBucket } from "../server/storage.js";
import { ensureSchema } from "../functions/_lib/db.js";

test("VPS runtime supports schema, upload, gallery and image delivery", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "roco-vps-"));
  const db = new D1Database(resolve(root, "gallery.sqlite"));
  const bucket = new LocalGalleryBucket(resolve(root, "images"));
  installCache({ maxBytes: 4 * 1024 * 1024, maxObjectBytes: 1024 * 1024 });

  try {
    await ensureSchema(db);
    const route = await createRouter();
    const env = {
      DB: db,
      GALLERY_BUCKET: bucket,
      MAX_UPLOAD_BYTES: String(1024 * 1024),
      FRIEND_ID_SECRET: "test-secret-that-is-long-enough",
      FRIEND_SESSION_DAYS: "30",
    };

    const initial = await route.dispatch(
      new Request("http://localhost/api/gallery"),
      env,
    );
    assert.equal(initial.status, 200);
    const initialData = await initial.json();
    assert.ok(initialData.categories.length >= 7);

    const pngBuffer = await sharp({
      create: {
        width: 1600,
        height: 1000,
        channels: 3,
        background: { r: 244, g: 181, b: 194 },
      },
    }).png().toBuffer();
    const png = new File(
      [pngBuffer],
      "sample.png",
      { type: "image/png" },
    );
    const form = new FormData();
    form.set("file", png);
    form.set("category", "lovely-ringo");
    form.set("time", "2026-07-23 12:34:56");
    form.set("title", "VPS runtime test");
    form.set("refreshSnapshot", "false");

    const uploaded = await route.dispatch(new Request(
      "http://localhost/api/admin/upload",
      {
        method: "POST",
        headers: { Origin: "http://localhost" },
        body: form,
      },
    ), env);
    assert.equal(uploaded.status, 201);
    const uploadData = await uploaded.json();
    assert.match(uploadData.image.id, /^[a-f0-9-]{36}$/);

    const image = await route.dispatch(
      new Request(`http://localhost/gallery/${uploadData.image.id}`),
      env,
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("Content-Type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), pngBuffer);

    const thumbnail = await route.dispatch(
      new Request(`http://localhost/gallery/${uploadData.image.id}?variant=thumbnail`),
      env,
    );
    assert.equal(thumbnail.status, 200);
    assert.equal(thumbnail.headers.get("Content-Type"), "image/webp");
    assert.match(thumbnail.headers.get("Cache-Control") || "", /immutable/);
    const thumbnailMetadata = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
    assert.equal(thumbnailMetadata.width, 1024);
    assert.equal(thumbnailMetadata.height, 640);

    const preview = await route.dispatch(
      new Request(`http://localhost/gallery/${uploadData.image.id}?variant=preview`),
      env,
    );
    assert.equal(preview.status, 200);
    const previewMetadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    assert.equal(previewMetadata.width, 1600);
    assert.equal(previewMetadata.height, 1000);

    const dbResult = await db.prepare("UPDATE gallery_items SET title = ?1 WHERE id = ?2")
      .bind("updated", uploadData.image.id)
      .run();
    assert.equal(dbResult.meta.changes, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import { ensureSchema } from "../_lib/db.js";
import { variantObjectKey } from "../_lib/image-variants.js";

const SUPPORTED_VARIANTS = new Set(["original", "thumbnail", "preview"]);

export async function onRequestGet(context) {
  try {
    const id = String(context.params.id || "");
    if (!/^[a-zA-Z0-9-]{12,64}$/.test(id)) return new Response("Not found", { status: 404 });

    const requestUrl = new URL(context.request.url);
    const download = requestUrl.searchParams.get("download") === "1";
    const requestedVariant = download
      ? "original"
      : String(requestUrl.searchParams.get("variant") || "original");
    if (!SUPPORTED_VARIANTS.has(requestedVariant)) {
      return new Response("Not found", { status: 404 });
    }
    const url = new URL(requestUrl.pathname, requestUrl.origin);
    if (download) url.searchParams.set("download", "1");
    if (requestedVariant !== "original") url.searchParams.set("variant", requestedVariant);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedEtag = cached.headers.get("ETag");
      if (cachedEtag && context.request.headers.get("If-None-Match") === cachedEtag) {
        return new Response(null, { status: 304, headers: { ETag: cachedEtag } });
      }
      return cached;
    }

    await ensureSchema(context.env.DB);
    const row = await context.env.DB.prepare(
      "SELECT object_key, content_type, shot_at, title FROM gallery_items WHERE id = ?1",
    )
      .bind(id)
      .first();
    if (!row) return new Response("Not found", { status: 404 });

    const requestedObjectKey = requestedVariant === "original"
      ? row.object_key
      : variantObjectKey(row.object_key, requestedVariant);
    let object = await context.env.GALLERY_BUCKET.get(requestedObjectKey);
    let variantFallback = false;
    if (!object && requestedVariant !== "original") {
      object = await context.env.GALLERY_BUCKET.get(row.object_key);
      variantFallback = Boolean(object);
    }
    if (!object) return new Response("Not found", { status: 404 });

    const etag = object.httpEtag || object.etag;
    if (etag && context.request.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", headers.get("Content-Type") || row.content_type || "image/webp");
    const cacheControl = variantFallback
      ? "public, max-age=300"
      : "public, max-age=31536000, immutable";
    headers.set("Cache-Control", cacheControl);
    headers.set("CDN-Cache-Control", cacheControl);
    headers.set("Vary", "Accept-Encoding");
    headers.set("X-Content-Type-Options", "nosniff");
    if (download) {
      const extension = String(row.object_key || "").split(".").pop() || "image";
      const filename = `${String(row.shot_at || id).replace(/[: ]/g, "-")}-${id}.${extension}`;
      headers.set("Content-Disposition", `attachment; filename="${filename}"`);
    }
    if (etag) headers.set("ETag", etag);
    const response = new Response(object.body, { headers });
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    console.error(error);
    return new Response("Image service unavailable", { status: 503 });
  }
}

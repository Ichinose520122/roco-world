import { createServer } from "node:http";
import { Readable } from "node:stream";
import { authenticateBasic } from "./auth.js";
import { installCache } from "./cache.js";
import { config, publicConfigSummary } from "./config.js";
import { D1Database } from "./db.js";
import { createRouter } from "./routes.js";
import { serveStatic } from "./static.js";
import { LocalGalleryBucket } from "./storage.js";

class RequestTooLargeError extends Error {}

async function readBody(request, maxBytes) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > maxBytes) throw new RequestTooLargeError();
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestTooLargeError();
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

function requestHeaders(nodeRequest) {
  const headers = new Headers();
  for (let index = 0; index < nodeRequest.rawHeaders.length; index += 2) {
    headers.append(nodeRequest.rawHeaders[index], nodeRequest.rawHeaders[index + 1]);
  }
  const forwardedIp = headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    || headers.get("X-Real-IP")
    || nodeRequest.socket.remoteAddress
    || "unknown";
  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", forwardedIp);
  return headers;
}

async function toFetchRequest(nodeRequest) {
  const headers = requestHeaders(nodeRequest);
  const forwardedProto = headers.get("X-Forwarded-Proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || (nodeRequest.socket.encrypted ? "https" : "http");
  const host = headers.get("X-Forwarded-Host") || headers.get("Host") || "localhost";
  const url = `${protocol}://${host}${nodeRequest.url || "/"}`;
  const method = nodeRequest.method || "GET";
  const body = ["GET", "HEAD"].includes(method)
    ? null
    : await readBody(nodeRequest, config.maxRequestBytes);
  return new Request(url, {
    method,
    headers,
    ...(body ? { body } : {}),
  });
}

function responseWithSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function sendResponse(nodeResponse, response, method) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  if (typeof response.headers.getSetCookie === "function") {
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies;
  }
  nodeResponse.writeHead(response.status, response.statusText, headers);
  if (method === "HEAD" || !response.body || [204, 304].includes(response.status)) {
    nodeResponse.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(response.body);
    stream.on("error", reject);
    nodeResponse.on("error", reject);
    nodeResponse.on("finish", resolve);
    stream.pipe(nodeResponse);
  });
}

function healthResponse(db, bucket) {
  try {
    return Response.json({
      ok: db.health() && bucket.health(),
      service: "roco-world-photo-vps",
      time: new Date().toISOString(),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

installCache({
  maxBytes: config.cacheMaxBytes,
  maxObjectBytes: config.cacheMaxObjectBytes,
});

const db = new D1Database(config.dbPath);
const bucket = new LocalGalleryBucket(config.storageRoot);
const env = {
  DB: db,
  GALLERY_BUCKET: bucket,
  MAX_UPLOAD_BYTES: String(config.maxUploadBytes),
  FRIEND_ID_SECRET: config.friendIdSecret,
  FRIEND_SESSION_DAYS: String(config.friendSessionDays),
};

const { ensureSchema } = await import("../functions/_lib/db.js");
await ensureSchema(db);
const router = await createRouter();

async function handle(nodeRequest, nodeResponse) {
  const startedAt = performance.now();
  let request;
  let response;
  try {
    request = await toFetchRequest(nodeRequest);
    const pathname = new URL(request.url).pathname;

    if (pathname === "/healthz") {
      response = healthResponse(db, bucket);
    } else {
      const adminPath = pathname === "/admin"
        || pathname.startsWith("/admin/")
        || pathname.startsWith("/api/admin/");
      if (adminPath) response = authenticateBasic(request, config);

      if (!response && pathname === "/admin") {
        response = new Response(null, {
          status: 308,
          headers: { Location: "/admin/", "Cache-Control": "no-store" },
        });
      }
      if (!response) response = await router.dispatch(request, env);
      if (!response && pathname.startsWith("/api/")) {
        response = Response.json({ ok: false, error: "接口不存在" }, { status: 404 });
      }
      if (!response) response = serveStatic(request, config.publicDir);
      if (!response) response = new Response("Not found", { status: 404 });
    }
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      response = Response.json({ ok: false, error: "请求体超过大小限制" }, { status: 413 });
    } else {
      console.error(error);
      response = Response.json({ ok: false, error: "服务器内部错误" }, { status: 500 });
    }
  }

  response = responseWithSecurityHeaders(response);
  await sendResponse(nodeResponse, response, nodeRequest.method || "GET");
  const elapsed = Math.round(performance.now() - startedAt);
  console.log(`${nodeRequest.method} ${nodeRequest.url} ${response.status} ${elapsed}ms`);
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error("Response failure", error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, config.host, () => {
  console.log("一ノ瀬林檎的小洛克冒险之旅 VPS 服务已启动");
  console.log(publicConfigSummary());
  console.log(`Local URL: http://${config.host}:${config.port}`);
  if (config.adminPassword.length < 16) {
    console.warn("警告：ADMIN_PASSWORD 尚未配置，管理后台当前不可用。");
  }
  if (config.friendIdSecret.length < 16) {
    console.warn("提示：FRIEND_ID_SECRET 尚未配置，好友登录当前不可用。");
  }
});

function shutdown(signal) {
  console.log(`${signal}: 正在安全关闭服务`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

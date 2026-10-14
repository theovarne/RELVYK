import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import rpcHandler from "./api/rpc.js";

const root = await realpath(dirname(fileURLToPath(import.meta.url)));
try { loadEnvFile(resolve(root, '.env.local')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
};

function respond(request, response, code, text, headers = {}) {
  response.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  response.end(request.method === "HEAD" ? undefined : text);
}

const server = createServer(async (request, response) => {
  const route = (request.url || '/').split('?')[0];
  if (route === '/api/rpc') {
    const apiResponse = Object.assign(response, {
      status(status) { response.statusCode = status; return this; },
      json(data) { response.end(JSON.stringify(data)); return this; },
    });
    const apiRequest = Object.assign(request, { body: '' });
    if (request.method === 'POST') {
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) { response.setHeader('content-type', 'application/json'); response.statusCode = 413; response.end(JSON.stringify({ error: { code: 'BODY_TOO_LARGE', message: 'The inspection request is too large.', retryable: false } })); return; }
        chunks.push(chunk);
      }
      apiRequest.body = Buffer.concat(chunks).toString('utf8');
    }
    await rpcHandler(apiRequest, apiResponse); return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return respond(request, response, 405, "Method Not Allowed\n", { Allow: "GET, HEAD" });
  }

  let pathname;
  try {
    pathname = decodeURIComponent((request.url || "/").split("?")[0]);
  } catch {
    return respond(request, response, 400, "Bad Request\n");
  }
  if (!pathname.startsWith("/") || pathname.includes("\0")) {
    return respond(request, response, 400, "Bad Request\n");
  }
  if (pathname.includes("\\") || pathname.split("/").includes("..")) {
    return respond(request, response, 403, "Forbidden\n");
  }
  if (pathname.split('/').some(part => part.startsWith('.')) || /^\/(api|tests|scripts|docs)\//.test(pathname) || ['/serve.mjs', '/package.json', '/pnpm-lock.yaml', '/README.txt', '/vercel.json', '/eslint.config.js', '/tsconfig.json'].includes(pathname)) return respond(request, response, 404, 'Not Found\n');

  try {
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) {
      return respond(request, response, 403, "Forbidden\n");
    }
    if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
    file = await realpath(file);
    if (file !== root && !file.startsWith(root + sep)) {
      return respond(request, response, 403, "Forbidden\n");
    }
    const details = await stat(file);
    if (!details.isFile()) return respond(request, response, 404, "Not Found\n");

    response.writeHead(200, {
      "Content-Type": types[extname(file).toLowerCase()] || (file.endsWith(`${sep}LICENSE`) ? "text/plain; charset=utf-8" : "application/octet-stream"),
      "Content-Length": details.size,
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") return response.end();
    const stream = createReadStream(file);
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  } catch (error) {
    const missing = error.code === "ENOENT" || error.code === "ENOTDIR";
    respond(request, response, missing ? 404 : 500, missing ? "Not Found\n" : "Internal Server Error\n");
  }
});

const port = Number(process.env.PORT || 4190);
server.listen(port, "127.0.0.1", () => {
  console.log(`RELVYK preview: http://127.0.0.1:${port}/`);
});
server.on("error", (error) => {
  console.error(`本地预览启动失败：${error.message}`);
  process.exitCode = 1;
});

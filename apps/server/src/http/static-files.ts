import { createReadStream, existsSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

export function serveStatic(webRoot: string, pathname: string, response: ServerResponse): boolean {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(webRoot, requested);
  const relative = path.relative(path.resolve(webRoot), candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const finalPath = existsSync(candidate) && statSync(candidate).isFile() ? candidate : path.join(webRoot, "index.html");
  if (!existsSync(finalPath)) return false;
  response.statusCode = 200;
  response.setHeader("Content-Type", MIME[path.extname(finalPath)] ?? "application/octet-stream");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("Cache-Control", finalPath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable");
  createReadStream(finalPath).pipe(response);
  return true;
}


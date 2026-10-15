import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i;

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").map((part) => {
    const [name, ...rest] = part.trim().split("=");
    return [name ?? "", decodeURIComponent(rest.join("="))];
  }));
}

function equalToken(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertLoopbackHost(request: IncomingMessage): void {
  const host = request.headers.host ?? "";
  if (!LOOPBACK_HOST.test(host)) throw Object.assign(new Error("只允许本机访问"), { code: "LOOPBACK_ONLY", status: 403 });
}

export function assertSession(request: IncomingMessage, token: string): void {
  const cookies = parseCookies(request.headers.cookie);
  const headerToken = request.headers["x-local-session"];
  const supplied = typeof headerToken === "string" ? headerToken : cookies.local_session;
  if (!equalToken(supplied, token)) throw Object.assign(new Error("本机会话无效，请刷新页面"), { code: "SESSION_REQUIRED", status: 401 });
}

export function assertOrigin(request: IncomingMessage): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) return;
  const origin = request.headers.origin;
  const host = request.headers.host;
  let trusted = false;
  if (typeof origin === "string" && typeof host === "string") {
    try {
      const parsed = new URL(origin);
      trusted = parsed.protocol === "http:"
        && LOOPBACK_HOST.test(parsed.host)
        && parsed.host.toLowerCase() === host.toLowerCase();
    } catch {
      trusted = false;
    }
  }
  if (!trusted) {
    throw Object.assign(new Error("请求来源不受信任"), { code: "ORIGIN_REJECTED", status: 403 });
  }
}

export function issueSessionCookie(response: ServerResponse, token: string): void {
  response.setHeader("Set-Cookie", `local_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
}

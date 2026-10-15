import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError, type ZodType } from "zod";
import type { ApiErrorBody } from "../../../../packages/contracts/src/index.js";
import { StoreError } from "../../../../packages/storage/src/index.js";

export function json(response: ServerResponse, status: number, body: unknown, correlationId?: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (correlationId) response.setHeader("X-Correlation-Id", correlationId);
  response.end(JSON.stringify(body));
}

export async function readJson<T>(request: IncomingMessage, schema: ZodType<T>): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 15_000_000) throw new StoreError("PAYLOAD_TOO_LARGE", "请求内容超过 15 MB", 413);
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new StoreError("VALIDATION", "请求不是有效 JSON", 400);
  }
  return schema.parse(value);
}

export function errorResponse(response: ServerResponse, error: unknown, correlationId = randomUUID()): void {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "操作失败，数据状态未标记为成功";
  let details: unknown;
  if (error instanceof StoreError) {
    status = error.status;
    code = error.code;
    message = error.message;
    details = error.details;
  } else if (error instanceof ZodError) {
    status = 400;
    code = "VALIDATION";
    message = "请修正标出的字段";
    details = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  } else if (error instanceof Error) {
    const candidate = error as Error & { code?: string; status?: number };
    status = candidate.status ?? 500;
    code = candidate.code ?? "INTERNAL_ERROR";
    if (status < 500) message = candidate.message;
  }
  const body: ApiErrorBody = { error: { code, message, correlationId, ...(details === undefined ? {} : { details }) } };
  json(response, status, body, correlationId);
}


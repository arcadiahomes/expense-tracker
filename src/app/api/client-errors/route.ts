import { z } from "zod";
import { reportError } from "@/server/monitoring";
import { clientIp, hit, LIMITS } from "@/server/rate-limit";
import { getSessionUser } from "@/server/session";

const report = z.object({
  message: z.string().max(1000),
  stack: z.string().max(8000).optional(),
  path: z.string().max(300).optional(),
});

/** Browser errors from src/instrumentation-client.ts. Signed-in users only, rate limited, size capped. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response(null, { status: 401 });
  if (!(await hit(`client-error:${await clientIp()}`, LIMITS.clientError)).allowed) return new Response(null, { status: 429 });
  const text = await req.text();
  if (text.length > 12_000) return new Response(null, { status: 413 });
  let body;
  try {
    body = report.parse(JSON.parse(text));
  } catch {
    return new Response(null, { status: 400 });
  }
  const err = Object.assign(new Error(body.message), { name: "ClientError", stack: body.stack ? `ClientError: ${body.message}\n${body.stack}` : undefined });
  await reportError(err, { source: "client", path: body.path, userId: user.id });
  return new Response(null, { status: 204 });
}

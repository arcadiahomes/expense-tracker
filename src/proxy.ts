import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirect for signed-out visitors. This only checks that a session
 * cookie exists; real authentication and authorization happen on the server
 * for every page, action and route (src/server/session.ts, authz.ts).
 */
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    const url = new URL("/sign-in", request.url);
    if (request.nextUrl.pathname !== "/") url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except auth pages, password links, the auth API, Next internals and static files.
  // The PWA files (manifest, service worker, offline page, icons) must load before sign-in.
  matcher: ["/((?!api/auth|sign-in|sign-up|set-password/|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|manifest.webmanifest|sw.js|offline.html|icons/|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};

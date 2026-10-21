import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SetPasswordForm } from "@/components/auth-form";
import { previewPasswordLink } from "@/server/data/accounts";

// The token is in the path; keep it out of Referer headers.
export const metadata: Metadata = { title: "Set password", referrer: "no-referrer" };

async function SetPassword({ params }: PageProps<"/set-password/[token]">) {
  const { token } = await params;
  const preview = await previewPasswordLink(token);
  if (!preview || preview.message) {
    return (
      <div className="grid gap-3">
        <h1 className="font-display text-xl font-bold">This link can&rsquo;t be used</h1>
        <p className="text-sm text-muted-foreground">{preview?.message ?? "This link is invalid. Ask the admin for a new one."}</p>
        <Link href="/sign-in" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  }
  return <SetPasswordForm token={token} email={preview.email} purpose={preview.purpose} />;
}

export default function SetPasswordPage(props: PageProps<"/set-password/[token]">) {
  return (
    <Suspense fallback={null}>
      <SetPassword {...props} />
    </Suspense>
  );
}

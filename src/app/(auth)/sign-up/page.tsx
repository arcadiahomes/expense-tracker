import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Create account" };

/** There is no public registration (the API refuses it too): the admin creates every account. */
export default function SignUpPage() {
  return (
    <div className="grid gap-3">
      <h1 className="font-display text-xl font-bold">Accounts are created by the admin</h1>
      <p className="text-sm text-muted-foreground">
        Arcadia Home doesn&rsquo;t take sign-ups. If you work on one of our sites, ask the admin to create your account. You&rsquo;ll get a
        link to set your password.
      </p>
      <Link href="/sign-in" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
        Go to sign in
      </Link>
    </div>
  );
}

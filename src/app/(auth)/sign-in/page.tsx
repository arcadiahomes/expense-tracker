import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = { title: "Sign in" };

async function SignIn({ searchParams }: PageProps<"/sign-in">) {
  const { next, password } = await searchParams;
  // The server action only follows same-site paths, whatever is passed here.
  return (
    <AuthForm
      next={typeof next === "string" ? next : undefined}
      notice={password === "set" ? "Your password is saved. Sign in with it." : undefined}
    />
  );
}

export default function SignInPage(props: PageProps<"/sign-in">) {
  return (
    <Suspense fallback={null}>
      <SignIn {...props} />
    </Suspense>
  );
}

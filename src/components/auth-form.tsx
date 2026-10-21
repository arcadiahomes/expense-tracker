"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/expense-form-dialog";
import { setPasswordAction, signInAction } from "@/server/actions/auth";

/** Email and password sign-in for everyone; the server sends each person to their own home. */
export function AuthForm({ next, notice }: { next?: string; notice?: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = { ...Object.fromEntries(new FormData(e.currentTarget)), ...(next && { next }) };
    start(async () => {
      // On success the action redirects, so a result only comes back on failure.
      const res = await signInAction(data);
      if (res && !res.ok) {
        setError(res.error);
        setErrors(res.fieldErrors ?? {});
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">Track site expenses for your company.</p>
      </div>
      {notice && (
        <p role="status" className="rounded-lg bg-secondary/70 px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      <Field label="Email" htmlFor="email" error={errors.email}>
        <Input id="email" name="email" type="email" autoComplete="email" className="h-11" />
      </Field>
      <Field label="Password" htmlFor="password" error={errors.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" className="h-11" />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-over">
          {error}
        </p>
      )}
      <Button type="submit" className="h-11" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Accounts are created by the admin. Forgot your password? Ask the admin for a reset link.
      </p>
    </form>
  );
}

/** Sets a password from a one-time link; the action signs the person in and redirects. */
export function SetPasswordForm({ token, email, purpose }: { token: string; email: string; purpose: "setup" | "reset" }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = { ...Object.fromEntries(new FormData(e.currentTarget)), token };
    start(async () => {
      const res = await setPasswordAction(data);
      if (res && !res.ok) {
        setError(res.error);
        setErrors(res.fieldErrors ?? {});
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <div>
        <h1 className="font-display text-xl font-bold">{purpose === "setup" ? "Set your password" : "Choose a new password"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {purpose === "setup" ? "Your account is ready. " : "Your other devices will be signed out. "}
          This link works once.
        </p>
      </div>
      <Field label="Email" htmlFor="email">
        {/* Lets password managers save the new password against the right account. */}
        <Input id="email" type="email" autoComplete="username" className="h-11" value={email} readOnly aria-readonly />
      </Field>
      <Field label="New password" htmlFor="password" error={errors.password}>
        <Input id="password" name="password" type="password" autoComplete="new-password" className="h-11" />
      </Field>
      <Field label="Repeat password" htmlFor="confirm" error={errors.confirm}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" className="h-11" />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-over">
          {error}
        </p>
      )}
      <Button type="submit" className="h-11" disabled={pending}>
        {pending ? "Saving…" : "Save password and sign in"}
      </Button>
    </form>
  );
}

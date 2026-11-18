import { useState, type FormEvent } from "react";
import { createAuthClient } from "better-auth/client";
import type { AuthPageProps } from "@tapedb/tapedb/react";
import "./auth.css";

const client = createAuthClient();

/** Copy this file and auth.css to the root of an app created with init --auth. */
export default function AuthPage({ redirectTo }: AuthPageProps) {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    try {
      const { error } = await client.signIn.email({
        email: String(form.get("email")),
        password: String(form.get("password")),
        callbackURL: redirectTo,
      });
      if (error) setMessage(error.message ?? "Sign-in failed.");
      else location.assign(redirectTo);
    } catch {
      setMessage("Could not reach the app. Try again.");
    } finally {
      setPending(false);
    }
  }

  return <main className="company-auth">
    <p className="company-auth__brand">Your company</p>
    <h1>Welcome back</h1>
    <form onSubmit={signIn}>
      <label>Email<input name="email" type="email" autoComplete="email" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <button disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      <p role="status">{message}</p>
    </form>
  </main>;
}

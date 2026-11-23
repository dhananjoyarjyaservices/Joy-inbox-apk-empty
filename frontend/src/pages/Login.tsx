import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Mail, Lock, MessageCircle, UserPlus } from "lucide-react";

import {
  loginWithEmail,
  loginWithGoogle,
  registerWithEmail,
} from "../services/auth";

const LEGACY_INBOX_OWNER_UID = "Vy49nGnw74gR5SFHmjN0DOQ2QFE3";

export default function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function continueToApp(uid: string) {
    navigate(uid === LEGACY_INBOX_OWNER_UID ? "/" : "/setup", { replace: true });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);
    try {
      if (mode === "register") {
        if (password.length < 6) throw new Error("Password kam se kam 6 characters ka hona chahiye.");
        const user = await registerWithEmail(email, password);
        setNotice("Account create ho gaya. Verification email bheja hai. Email verify karke setup complete karo.");
        continueToApp(user.uid);
      } else {
        const user = await loginWithEmail(email, password);
        continueToApp(user.uid);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request complete nahi hui. Dobara try karo.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const user = await loginWithGoogle();
      continueToApp(user.uid);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Google login failed. Dobara try karo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#eef2f3] px-4 py-8">
      <section className="w-full max-w-md rounded-2xl bg-white p-7 shadow-lg sm:p-9">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#075e54] text-white">
            <MessageCircle size={34} />
          </div>
          <h1 className="text-3xl font-bold text-[#075e54]">JOY INBOX</h1>
          <p className="mt-2 text-sm text-gray-500">
            {mode === "login" ? "Sign in to your customer support inbox" : "Create your Joy Inbox business account"}
          </p>
        </div>

        <div className="mb-5 grid grid-cols-2 rounded-xl bg-gray-100 p-1">
          <button type="button" onClick={() => { setMode("login"); setError(""); setNotice(""); }} className={`rounded-lg py-2 text-sm font-semibold ${mode === "login" ? "bg-white text-[#075e54] shadow-sm" : "text-gray-500"}`}>Sign in</button>
          <button type="button" onClick={() => { setMode("register"); setError(""); setNotice(""); }} className={`rounded-lg py-2 text-sm font-semibold ${mode === "register" ? "bg-white text-[#075e54] shadow-sm" : "text-gray-500"}`}>Create account</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">Email address</label>
            <div className="flex items-center gap-3 rounded-xl border border-gray-200 px-4">
              <Mail size={18} className="text-gray-400" />
              <input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Enter your email" className="h-12 w-full bg-transparent text-sm outline-none" />
            </div>
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">Password</label>
            <div className="flex items-center gap-3 rounded-xl border border-gray-200 px-4">
              <Lock size={18} className="text-gray-400" />
              <input type="password" required minLength={6} autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "login" ? "Enter your password" : "Create a password (6+ characters)"} className="h-12 w-full bg-transparent text-sm outline-none" />
            </div>
          </div>

          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</p>}
          {notice && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-700">{notice}</p>}

          <button type="submit" disabled={loading} className="w-full rounded-xl bg-[#075e54] py-3 font-semibold text-white transition hover:bg-[#064c44] disabled:opacity-60">
            {loading ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-gray-200" />
          <span className="text-xs text-gray-400">OR</span>
          <div className="h-px flex-1 bg-gray-200" />
        </div>

        <button type="button" onClick={handleGoogleLogin} disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 py-3 font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-60">
          <UserPlus size={17} /> Continue with Google
        </button>
        <p className="mt-6 text-center text-xs leading-5 text-gray-400">
          New business accounts complete organisation setup after sign in. The legacy inbox remains restricted to its existing owner until tenant migration is finished.
        </p>
      </section>
    </main>
  );
}

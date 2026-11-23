import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  sendEmailVerification,
  onAuthStateChanged,
  type User,
} from "firebase/auth";

import { auth, googleProvider } from "../firebase/config";

export async function loginWithEmail(
  email: string,
  password: string
): Promise<User> {
  const result = await signInWithEmailAndPassword(
    auth,
    email.trim(),
    password
  );

  return result.user;
}

export async function registerWithEmail(
  email: string,
  password: string
): Promise<User> {
  const result = await createUserWithEmailAndPassword(
    auth,
    email.trim(),
    password
  );

  // Workspace invitations require Firebase's verified-email claim. Send the
  // verification message and sign out so the new account cannot proceed as
  // an unverified member.
  try {
    await sendEmailVerification(result.user);
  } finally {
    await signOut(auth);
  }

  return result.user;
}

export async function resendVerificationEmail(user: User): Promise<void> {
  await sendEmailVerification(user);
}

export async function loginWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function logout(): Promise<void> {
  await signOut(auth);
}

export function observeAuth(
  callback: (user: User | null) => void
) {
  return onAuthStateChanged(auth, callback);
}

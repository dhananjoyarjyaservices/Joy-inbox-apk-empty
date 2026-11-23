import { getMessaging, getToken, isSupported, onMessage } from "firebase/messaging";
import { auth, firebaseApp } from "../firebase/config";
import { getActiveOrganizationId } from "./activeOrganization";

const API_URL = import.meta.env.VITE_API_BASE_URL;
const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;
const INSTALLATION_ID_KEY = "joy-inbox-push-installation-id";
type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

function firebaseWebConfig(): FirebaseWebConfig {
  const options = firebaseApp.options;
  if (
    !options.apiKey ||
    !options.authDomain ||
    !options.projectId ||
    !options.storageBucket ||
    !options.messagingSenderId ||
    !options.appId
  ) {
    throw new Error("Firebase Messaging configuration is incomplete.");
  }
  return {
    apiKey: options.apiKey,
    authDomain: options.authDomain,
    projectId: options.projectId,
    storageBucket: options.storageBucket,
    messagingSenderId: options.messagingSenderId,
    appId: options.appId,
  };
}

function getInstallationId(): string {
  let installationId = localStorage.getItem(INSTALLATION_ID_KEY);
  if (!installationId) {
    installationId = crypto.randomUUID();
    localStorage.setItem(INSTALLATION_ID_KEY, installationId);
  }
  return installationId;
}

async function authenticatedRequest(path: string, body: object): Promise<void> {
  if (!API_URL) {
    throw new Error("AWS API URL is not configured.");
  }
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Please sign in again.");
  }
  const idToken = await user.getIdToken();
  const response = await fetch(`${API_URL.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) {
    throw new Error(result.error || "Push notification settings could not be updated.");
  }
}

async function getMessagingServiceWorker(): Promise<ServiceWorkerRegistration> {
  const config = firebaseWebConfig();
  const workerUrl = new URL(
    `${import.meta.env.BASE_URL}firebase-messaging-sw.js`,
    window.location.origin,
  );
  for (const [key, value] of Object.entries(config)) {
    workerUrl.searchParams.set(key, value);
  }
  return navigator.serviceWorker.register(workerUrl, {
    scope: import.meta.env.BASE_URL,
  });
}

async function requestFcmToken(): Promise<string> {
  if (!(await isSupported())) {
    throw new Error("Push notifications are not supported in this browser.");
  }
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser does not support service workers.");
  }
  if (!VAPID_KEY) {
    throw new Error("VITE_FIREBASE_VAPID_KEY is not configured.");
  }
  if (Notification.permission !== "granted") {
    throw new Error("Notification permission has not been granted.");
  }

  const serviceWorkerRegistration = await getMessagingServiceWorker();
  const token = await getToken(getMessaging(firebaseApp), {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration,
  });
  if (!token) {
    throw new Error("Firebase did not return a device token.");
  }
  return token;
}

export async function enablePushNotifications(): Promise<void> {
  if (!("Notification" in window)) {
    throw new Error("Notifications are not supported in this browser.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notification permission is blocked in browser settings."
        : "Notification permission was not granted.",
    );
  }

  if (!(await isSupported())) {
    throw new Error("Push notifications are not supported in this browser.");
  }

  await syncPushToken();
}

export async function syncPushToken(): Promise<void> {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const token = await requestFcmToken();
  const installationId = getInstallationId();
  const organizationId = getActiveOrganizationId();
  if (!organizationId) throw new Error("Please select an organization before enabling notifications.");
  await authenticatedRequest("/organizations/fcm-tokens/register", { token, installationId, organizationId });
}

let notificationAudioContext: AudioContext | null = null;

export function playNotificationSound(): void {
  try {
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;
    notificationAudioContext ||= new AudioContextConstructor();
    if (notificationAudioContext.state === "suspended") void notificationAudioContext.resume();
    const oscillator = notificationAudioContext.createOscillator();
    const gain = notificationAudioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, notificationAudioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(660, notificationAudioContext.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, notificationAudioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, notificationAudioContext.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, notificationAudioContext.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(notificationAudioContext.destination);
    oscillator.start();
    oscillator.stop(notificationAudioContext.currentTime + 0.19);
  } catch (error) {
    console.warn("Notification sound could not play:", error);
  }
}

export async function listenForForegroundPush(callback: (data: Record<string, string>) => void): Promise<() => void> {
  if (!(await isSupported())) return () => undefined;
  return onMessage(getMessaging(firebaseApp), payload => callback(payload.data || {}));
}

export async function disablePushNotifications(): Promise<void> {
  const installationId = localStorage.getItem(INSTALLATION_ID_KEY);
  const organizationId = getActiveOrganizationId();
  if (installationId && organizationId) {
    await authenticatedRequest("/organizations/fcm-tokens/remove", { installationId, organizationId });
  }
}

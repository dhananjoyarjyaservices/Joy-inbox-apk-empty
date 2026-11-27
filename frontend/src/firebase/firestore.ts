import { getFirestore } from "firebase/firestore";
import { firebaseApp } from "./config";

// Keep Firestore out of the authentication/login entry bundle.
// Workspace pages import this module only when they need tenant data listeners.
export const db = getFirestore(firebaseApp);

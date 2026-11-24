import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from "firebase/firestore";

import { db } from "../firebase/firestore";
import type { QuickReply } from "../types";

function quickRepliesCollection(organizationId: string) {
  const id = organizationId.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error("Select a valid business workspace first.");
  }
  return collection(db, "organizations", id, "quickReplies");
}

export async function getTenantQuickReply(
  organizationId: string,
  replyId: string
): Promise<QuickReply | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(replyId)) return null;
  const snapshot = await getDoc(doc(quickRepliesCollection(organizationId), replyId));
  return snapshot.exists()
    ? ({ id: snapshot.id, ...snapshot.data() } as QuickReply)
    : null;
}

export function listenToTenantQuickReplies(
  organizationId: string,
  callback: (replies: QuickReply[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const repliesQuery = query(quickRepliesCollection(organizationId), orderBy("createdAt", "desc"));
  return onSnapshot(
    repliesQuery,
    (snapshot) => callback(snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    })) as QuickReply[]),
    (error) => onError?.(error)
  );
}

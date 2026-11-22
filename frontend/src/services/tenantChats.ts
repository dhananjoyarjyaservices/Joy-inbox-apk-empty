import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";

import { db } from "../firebase/config";
import type { Chat, ChatMessage } from "../types";

const CHAT_PAGE_SIZE = 50;
const MESSAGE_PAGE_SIZE = 50;

function requireOrganizationId(organizationId: string): string {
  const value = organizationId.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Select a valid business workspace first.");
  }
  return value;
}

function organizationChats(organizationId: string) {
  return collection(db, "organizations", requireOrganizationId(organizationId), "chats");
}

export async function getTenantChatById(
  organizationId: string,
  chatId: string
): Promise<Chat | null> {
  if (!/^\+?\d{6,20}$/.test(chatId)) return null;
  const snapshot = await getDoc(doc(organizationChats(organizationId), chatId.replace(/^\+/, "")));
  if (!snapshot.exists()) return null;
  return { id: snapshot.id, ...snapshot.data() } as Chat;
}

export async function getTenantMessage(
  organizationId: string,
  chatId: string,
  messageId: string
): Promise<ChatMessage | null> {
  if (!/^\+?\d{6,20}$/.test(chatId) || !/^[A-Za-z0-9._:-]{1,256}$/.test(messageId)) return null;
  const snapshot = await getDoc(doc(
    organizationChats(organizationId),
    chatId.replace(/^\+/, ""),
    "messages",
    messageId
  ));
  if (!snapshot.exists()) return null;
  return { id: snapshot.id, ...snapshot.data() } as ChatMessage;
}

export function listenToTenantChats(
  organizationId: string,
  callback: (chats: Chat[], oldest: QueryDocumentSnapshot<DocumentData> | null, hasOlder: boolean) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const chatsQuery = query(
    organizationChats(organizationId),
    orderBy("lastMessageAt", "desc"),
    limit(CHAT_PAGE_SIZE)
  );
  return onSnapshot(chatsQuery, (snapshot) => {
    callback(
      snapshot.docs.map((item) => ({ id: item.id, ...item.data() })) as Chat[],
      snapshot.docs.at(-1) || null,
      snapshot.size === CHAT_PAGE_SIZE
    );
  }, (error) => onError?.(error));
}

export async function loadOlderTenantChats(
  organizationId: string,
  cursor: QueryDocumentSnapshot<DocumentData>
) {
  const snapshot = await getDocs(query(
    organizationChats(organizationId),
    orderBy("lastMessageAt", "desc"),
    startAfter(cursor),
    limit(CHAT_PAGE_SIZE)
  ));
  return {
    chats: snapshot.docs.map((item) => ({ id: item.id, ...item.data() })) as Chat[],
    cursor: snapshot.docs.at(-1) || cursor,
    hasOlder: snapshot.size === CHAT_PAGE_SIZE,
  };
}

export function listenToTenantMessages(
  organizationId: string,
  chatId: string,
  callback: (messages: ChatMessage[], oldest: QueryDocumentSnapshot<DocumentData> | null, hasOlder: boolean) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  if (!/^\+?\d{6,20}$/.test(chatId)) throw new Error("Conversation phone number is invalid.");
  const messagesQuery = query(
    collection(organizationChats(organizationId), chatId.replace(/^\+/, ""), "messages"),
    orderBy("timestamp", "desc"),
    limit(MESSAGE_PAGE_SIZE)
  );
  return onSnapshot(messagesQuery, (snapshot) => {
    callback(
      snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as ChatMessage)).reverse(),
      snapshot.docs.at(-1) || null,
      snapshot.size === MESSAGE_PAGE_SIZE
    );
  }, (error) => onError?.(error));
}

export function listenToTenantPinnedMessages(
  organizationId: string,
  chatId: string,
  callback: (messages: ChatMessage[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  if (!/^\+?\d{6,20}$/.test(chatId)) throw new Error("Conversation phone number is invalid.");
  const messagesQuery = query(
    collection(organizationChats(organizationId), chatId.replace(/^\+/, ""), "messages"),
    where("pinned", "==", true)
  );
  return onSnapshot(messagesQuery, (snapshot) => {
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })) as ChatMessage[]);
  }, (error) => onError?.(error));
}

export async function loadOlderTenantMessages(
  organizationId: string,
  chatId: string,
  cursor: QueryDocumentSnapshot<DocumentData>
) {
  if (!/^\+?\d{6,20}$/.test(chatId)) throw new Error("Conversation phone number is invalid.");
  const snapshot = await getDocs(query(
    collection(organizationChats(organizationId), chatId.replace(/^\+/, ""), "messages"),
    orderBy("timestamp", "desc"),
    startAfter(cursor),
    limit(MESSAGE_PAGE_SIZE)
  ));
  return {
    messages: snapshot.docs.map((item) => ({ id: item.id, ...item.data() })) as ChatMessage[] .reverse(),
    cursor: snapshot.docs.at(-1) || cursor,
    hasOlder: snapshot.size === MESSAGE_PAGE_SIZE,
  };
}

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
import type { Contact } from "../types";

function contactsCollection(organizationId: string) {
  const id = organizationId.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error("Select a valid business workspace first.");
  }
  return collection(db, "organizations", id, "contacts");
}

export async function getTenantContact(
  organizationId: string,
  contactId: string
): Promise<Contact | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(contactId)) return null;
  const snapshot = await getDoc(doc(contactsCollection(organizationId), contactId));
  return snapshot.exists()
    ? ({ id: snapshot.id, ...snapshot.data() } as Contact)
    : null;
}

export function listenToTenantContacts(
  organizationId: string,
  callback: (contacts: Contact[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const contactsQuery = query(contactsCollection(organizationId), orderBy("name", "asc"));
  return onSnapshot(
    contactsQuery,
    (snapshot) => callback(snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    })) as Contact[]),
    (error) => onError?.(error)
  );
}

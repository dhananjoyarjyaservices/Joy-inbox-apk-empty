const { getDb, getFirebaseAdmin } = require("../src/firebase");
const { deleteMessageMedia } = require("../src/media");

const PAGE_SIZE = 200;
const CONFIRM = process.env.CONFIRM_DELETE_INBOUND_MEDIA === "true";

async function main() {
  const db = getDb();
  let cursor = null;
  let scanned = 0;
  let candidates = 0;
  let deleted = 0;
  let failures = 0;

  console.log(CONFIRM
    ? "CONFIRM mode enabled: deleting stored inbound customer media."
    : "DRY RUN: no files will be deleted. Set CONFIRM_DELETE_INBOUND_MEDIA=true to execute.");

  while (true) {
    let query = db.collectionGroup("messages")
      .where("direction", "==", "incoming")
      .orderBy("__name__")
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      scanned += 1;
      const data = doc.data();
      const storagePath = data.mediaStoragePath;
      if (typeof storagePath !== "string" || !storagePath.startsWith("messages/")) continue;
      candidates += 1;
      if (!CONFIRM) continue;

      try {
        await deleteMessageMedia(storagePath);
        await doc.ref.update({
          mediaStoragePath: null,
          mediaId: getFirebaseAdmin().firestore.FieldValue.delete(),
          mediaMimeType: getFirebaseAdmin().firestore.FieldValue.delete(),
          mediaSize: getFirebaseAdmin().firestore.FieldValue.delete(),
          mediaFilename: getFirebaseAdmin().firestore.FieldValue.delete(),
          mediaSha256: getFirebaseAdmin().firestore.FieldValue.delete(),
          mediaDownloadError: "Customer media was removed under the text-only retention policy."
        });
        deleted += 1;
      } catch (error) {
        failures += 1;
        console.error("Could not remove media for message", doc.id, error.message);
      }
    }

    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) break;
  }

  console.log(JSON.stringify({ scanned, candidates, deleted, failures, dryRun: !CONFIRM }, null, 2));
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Inbound media cleanup failed:", error);
  process.exitCode = 1;
});

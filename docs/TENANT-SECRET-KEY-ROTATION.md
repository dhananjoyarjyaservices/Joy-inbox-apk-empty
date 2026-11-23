# Tenant WhatsApp credential encryption and key rotation

## Current format

Tenant WhatsApp access tokens are encrypted with AES-256-GCM. New records use format version 2 and include a non-secret `keyId`. Existing version 1 records remain readable through the legacy `TENANT_SECRET_ENCRYPTION_KEY` setting.

Never put encryption keys in source control, frontend environment variables, logs, API responses, or Firestore documents.

## Keyring configuration

Set `TENANT_SECRET_ENCRYPTION_KEYRING` only in the backend secret manager. Its JSON value has this shape:

```json
{
  "activeKeyId": "key_2026_11",
  "keys": {
    "key_2025_06": "BASE64_ENCODED_32_BYTE_OLD_KEY",
    "key_2026_11": "BASE64_ENCODED_32_BYTE_NEW_KEY"
  }
}
```

Every key must decode to exactly 32 bytes. Keep old keys in the keyring while any stored credential still references them. New credentials are encrypted with `activeKeyId`; decryption selects the key by the record's `keyId`.

## Safe staged rotation

1. Back up the existing backend secret values securely. Do not export or print plaintext access tokens.
2. Generate a fresh cryptographically random 32-byte key and encode it as base64.
3. Deploy the version that supports version 2 records.
4. Configure the keyring with both old and new keys, and set the new key as `activeKeyId`. Keep `TENANT_SECRET_ENCRYPTION_KEY` set to the old key so version 1 records remain readable.
5. Verify that a newly connected WhatsApp number can be saved and its credentials can be read.
6. Re-encrypt existing version 1 and old-key version 2 records using the exported `rotateEncryptedSecret` helper in a controlled migration process. Update the matching Firestore credential records without logging token plaintext. This repository currently provides the per-record rotation helper; it does not yet run an automatic all-tenant migration.
7. Verify every active connection can decrypt successfully before removing any old key.
8. Keep a protected backup of the old key until the migration and rollback window are complete. Then remove the old key from the keyring and retire the legacy key setting only after confirming no stored records reference it.

## Failure behavior

- Invalid keyring JSON, malformed keys, missing active keys, unknown key IDs, and failed AES-GCM authentication throw errors; decryption fails closed.
- Do not catch decryption failures and continue with an empty or fallback access token.
- A key must never be removed while stored records still depend on it.
- If a key is lost, ciphertext encrypted under that key cannot be recovered; reconnect the affected WhatsApp number with a fresh Meta token.

## Rotation API

`rotateEncryptedSecret(record, { sourceKeyValue, targetKeyring })` returns a new version 2 encrypted record. `targetKeyring` can be the JSON keyring string or an object containing `activeKeyId` and a `keys` map. The helper does not write to Firestore; callers must persist the returned record safely.

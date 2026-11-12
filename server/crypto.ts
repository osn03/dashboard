import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Cipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

/** AES-256-GCM for secrets at rest (integration tokens). Key: 32 random bytes, base64. */
export function makeCipher(keyBase64: string): Cipher {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded. Run `npm run setup` to generate one.');
  }
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
    },
    decrypt(stored) {
      if (!stored.startsWith('v1:')) throw new Error('Unknown ciphertext format');
      const raw = Buffer.from(stored.slice(3), 'base64');
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

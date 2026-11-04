import { randomBytes } from 'node:crypto';

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newId(): string {
  return randomBytes(9).toString('base64url');
}

export function newInviteCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join('');
}

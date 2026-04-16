import { ref, get } from './firebase-firestore-compat.js';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export async function isAdminUser(db, user, timeoutMs = 5000) {
  const userEmail = normalizeEmail(user?.email);
  if (!userEmail) return false;

  const snapshot = await Promise.race([
    get(ref(db, 'admin/security')),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Admin security timeout')), timeoutMs))
  ]);

  if (!snapshot.exists()) return false;

  const data = snapshot.val() || {};
  const adminEmails = Array.isArray(data.email)
    ? data.email
    : Array.isArray(data.emails)
      ? data.emails
      : [];

  return adminEmails.some((email) => normalizeEmail(email) === userEmail);
}

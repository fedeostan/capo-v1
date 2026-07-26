'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth } from '@capo/db/session';
import { logEvent } from '@/lib/log';

// Editing your own company name or contact details is a manager command, the
// same category as tapping "Concluir" — a sanctioned non-chat write path.
//
// Deliberately NO assertNotBlocked here, unlike every other write path in the
// app: a tenant whose subscription lapsed must still be able to correct their
// details and reach the billing page. Blocking that would be blocking them
// from paying us.
//
// The real guard is at the grant level, not here: migration 0011 revokes
// UPDATE on companies and re-grants only (name), and 0007 grants only
// (full_name, phone) on profiles. Even a forged request cannot touch
// company_id or the billing columns.

export type FormState = { ok?: true; error?: string } | null;

// Same normalization stance as onboarding/actions.ts: a bare PT mobile
// ("912345678") becomes +351912345678; anything else must already be E.164.
// The DB check constraint re-validates — this is UX, not the guard.
function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, '');
  const phone = /^9\d{8}$/.test(compact) ? `+351${compact}` : compact;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function validName(value: string): boolean {
  return value.length >= 1 && value.length <= 120;
}

export async function updateCompanyName(_prev: FormState, formData: FormData): Promise<FormState> {
  const name = String(formData.get('nome') ?? '').trim();
  if (!validName(name)) return { error: 'O nome da empresa tem de ter entre 1 e 120 caracteres.' };

  const { db, companyId } = await requireAuth();
  const { error } = await db.from('companies').update({ name }).eq('id', companyId);
  if (error) {
    console.error('updateCompanyName failed:', error.message);
    return { error: 'Não foi possível guardar. Tenta outra vez.' };
  }

  logEvent('profile.company_renamed', { companyId });
  revalidatePath('/perfil');
  return { ok: true };
}

export async function updateProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const fullName = String(formData.get('nome') ?? '').trim();
  const phone = normalizePhone(String(formData.get('telemovel') ?? ''));
  if (!validName(fullName)) return { error: 'O nome tem de ter entre 1 e 120 caracteres.' };
  if (!phone) return { error: 'Número inválido. Usa o formato +351912345678.' };

  const { db, userId, companyId } = await requireAuth();
  const { error } = await db.from('profiles').update({ full_name: fullName, phone }).eq('id', userId);
  if (error) {
    // profiles.phone is unique — the manager's number is how inbound routing
    // will resolve a sender, so a collision is a real conflict, not a glitch.
    if (error.code === '23505') return { error: 'Esse número já está associado a outra conta.' };
    console.error('updateProfile failed:', error.message);
    return { error: 'Não foi possível guardar. Tenta outra vez.' };
  }

  logEvent('profile.updated', { companyId, userId });
  revalidatePath('/perfil');
  return { ok: true };
}

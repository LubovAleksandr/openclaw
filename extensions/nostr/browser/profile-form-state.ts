import type { NostrProfile } from "./types.ts";

export const NOSTR_PROFILE_FIELDS = [
  "name",
  "displayName",
  "about",
  "picture",
  "banner",
  "website",
  "nip05",
  "lud16",
] as const satisfies readonly (keyof NostrProfile)[];

export interface NostrProfileFormState {
  values: NostrProfile;
  original: NostrProfile;
  saving: boolean;
  importing: boolean;
  error: string | null;
  success: string | null;
  fieldErrors: Record<string, string>;
  showAdvanced: boolean;
}

export function createNostrProfileFormState(
  profile: NostrProfile | undefined,
): NostrProfileFormState {
  const values: NostrProfile = Object.fromEntries(
    NOSTR_PROFILE_FIELDS.map((field) => [field, profile?.[field] ?? ""]),
  );

  return {
    values,
    original: { ...values },
    saving: false,
    importing: false,
    error: null,
    success: null,
    fieldErrors: {},
    showAdvanced: Boolean(profile?.banner || profile?.website || profile?.nip05 || profile?.lud16),
  };
}

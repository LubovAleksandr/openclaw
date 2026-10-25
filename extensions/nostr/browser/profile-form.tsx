/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { SettingsRow, SettingsStatus } from "./components.tsx";
import type { Translator } from "./i18n/index.ts";
import { NOSTR_PROFILE_FIELDS, type NostrProfileFormState } from "./profile-form-state.ts";
import type { NostrProfile as NostrProfileType } from "./types.ts";

export interface NostrProfileFormCallbacks {
  onFieldChange: (field: keyof NostrProfileType, value: string) => void;
  onSave: () => void;
  onImport: () => void;
  onCancel: () => void;
  onToggleAdvanced: () => void;
}

type ProfileField = readonly [
  key: keyof NostrProfileType,
  label: string,
  placeholder: string,
  help: string,
  type: "text" | "url" | "textarea",
];

const BASIC_FIELDS = [
  ["name", "username", "placeholders.username", "usernameHelp", "text"],
  ["displayName", "displayName", "placeholders.displayName", "displayNameHelp", "text"],
  ["about", "bio", "bioPlaceholder", "bioHelp", "textarea"],
  ["picture", "avatarUrl", "placeholders.avatarUrl", "avatarHelp", "url"],
] as const satisfies readonly ProfileField[];

const ADVANCED_FIELDS = [
  ["banner", "bannerUrl", "placeholders.bannerUrl", "bannerHelp", "url"],
  ["website", "website", "placeholders.website", "websiteHelp", "url"],
  ["nip05", "nip05Identifier", "placeholders.nip05", "nip05Help", "text"],
  ["lud16", "lightningAddress", "placeholders.lightningAddress", "lightningHelp", "text"],
] as const satisfies readonly ProfileField[];

export function NostrProfileForm(params: {
  t: Translator;
  state: NostrProfileFormState;
  callbacks: NostrProfileFormCallbacks;
  accountId: string;
  connected: boolean;
}): JSX.Element {
  const isDirty = createMemo(() =>
    NOSTR_PROFILE_FIELDS.some(
      (field) => params.state.values[field] !== params.state.original[field],
    ),
  );

  const renderField = ([field, labelKey, placeholderKey, helpKey, type]: ProfileField) => {
    const help = createMemo(() => params.t(`channels.nostr.${helpKey}`));
    const value = createMemo(() => params.state.values[field] ?? "");
    const error = createMemo(() => params.state.fieldErrors[field]);

    const inputId = `nostr-profile-${field}`;
    const helpId = `${inputId}-help`;
    const errorId = `${inputId}-error`;
    const descriptionIds = createMemo(() =>
      [help() ? helpId : "", error() ? errorId : ""].filter(Boolean).join(" "),
    );
    const multiline = type === "textarea";
    const control = multiline ? (
      <textarea
        id={inputId}
        class="settings-input"
        value={value()}
        placeholder={params.t(`channels.nostr.${placeholderKey}`)}
        maxlength="2000"
        rows="3"
        aria-describedby={descriptionIds() || undefined}
        aria-invalid={error() ? "true" : undefined}
        onInput={(event) => params.callbacks.onFieldChange(field, event.currentTarget.value)}
        disabled={params.state.saving}
      />
    ) : (
      <input
        id={inputId}
        class="settings-input"
        type={type}
        value={value()}
        placeholder={params.t(`channels.nostr.${placeholderKey}`)}
        maxlength="256"
        aria-describedby={descriptionIds() || undefined}
        aria-invalid={error() ? "true" : undefined}
        onInput={(event) => params.callbacks.onFieldChange(field, event.currentTarget.value)}
        disabled={params.state.saving}
      />
    );

    return (
      <div class="settings-row settings-row--stacked">
        <div class="settings-row__text">
          <label class="settings-row__title" for={inputId}>
            {params.t(`channels.nostr.${labelKey}`)}
          </label>
          {help() ? (
            <span id={helpId} class="settings-row__desc">
              {help()}
            </span>
          ) : undefined}
          {error() ? (
            <span id={errorId} class="settings-row__desc" style={{ color: "var(--danger)" }}>
              {error()}
            </span>
          ) : undefined}
        </div>
        <div class="settings-row__control">{control}</div>
      </div>
    );
  };

  return (
    <>
      <SettingsRow
        title={params.t("channels.nostr.editProfile")}
        description={
          <>
            {params.t("channels.nostr.account")}: {params.accountId}
          </>
        }
      />
      {params.state.error ? (
        <SettingsRow
          role={"alert"}
          title={<SettingsStatus kind={"danger"} label={params.t("channels.lastError")} />}
          description={params.state.error}
        />
      ) : undefined}
      {params.state.success ? (
        <div class="settings-row" role="status">
          <div class="settings-row__text">
            <span class="settings-row__desc">{params.state.success}</span>
          </div>
        </div>
      ) : undefined}
      {params.state.values.picture ? (
        <SettingsRow
          title={params.t("channels.nostr.profilePicturePreview")}
          control={
            <img
              src={params.state.values.picture}
              alt={params.t("channels.nostr.profilePicturePreview")}
              style={{
                "max-width": "80px",
                "max-height": "80px",
                "border-radius": "50%",
                "object-fit": "cover",
              }}
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
              onLoad={(event) => {
                event.currentTarget.style.display = "block";
              }}
            />
          }
        />
      ) : undefined}
      {BASIC_FIELDS.map(renderField)}
      {params.state.showAdvanced ? (
        <>
          <SettingsRow title={params.t("channels.nostr.advanced")} />
          {ADVANCED_FIELDS.map(renderField)}
        </>
      ) : undefined}

      <div class="settings-row">
        <div class="settings-row__text">
          {isDirty() ? (
            <span class="settings-row__desc">{params.t("common.unsavedChanges")}</span>
          ) : undefined}
        </div>
        <div class="settings-row__control">
          <button
            class="btn primary"
            onClick={() => params.callbacks.onSave()}
            disabled={!params.connected || params.state.saving || !isDirty()}
          >
            {params.state.saving ? params.t("common.saving") : params.t("common.saveAndPublish")}
          </button>

          <button
            class="btn"
            onClick={() => params.callbacks.onImport()}
            disabled={!params.connected || params.state.importing || params.state.saving}
          >
            {params.state.importing
              ? params.t("common.importing")
              : params.t("common.importFromRelays")}
          </button>

          <button
            class="btn"
            aria-expanded={params.state.showAdvanced ? "true" : "false"}
            onClick={() => params.callbacks.onToggleAdvanced()}
          >
            {params.state.showAdvanced
              ? params.t("common.hideAdvanced")
              : params.t("common.showAdvanced")}
          </button>

          <button
            class="btn"
            onClick={() => params.callbacks.onCancel()}
            disabled={params.state.saving}
          >
            {params.t("common.cancel")}
          </button>
        </div>
      </div>
    </>
  );
}

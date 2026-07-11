<script lang="ts">
  import { authClient } from "@codecrawler/auth/client";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import QRCode from "qrcode";
  import { ApiError, api } from "$lib/api";
  import { toastError, toastInfo, toastSuccess } from "$lib/toast.svelte";
  import type { PasskeyRow } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let twoFactorEnabled = $state(data.twoFactorEnabled);
  let passkeys = $state<PasskeyRow[]>(data.passkeys);

  // --- 2FA enable flow ---
  // enable → show QR + backup codes → verify → confirmed.
  let enablePassword = $state("");
  let enabling = $state(false);
  let step: "idle" | "confirm" = $state("idle");
  let totpUri = $state("");
  let backupCodes = $state<string[]>([]);
  let qrDataUrl = $state("");
  let manualSecret = $state("");
  let verifyCode = $state("");
  let verifying = $state(false);

  // --- 2FA disable flow ---
  let disablePassword = $state("");
  let disabling = $state(false);

  // --- passkey add ---
  let newPasskeyName = $state("");
  let addingPasskey = $state(false);
  let deletingId = $state<string | null>(null);

  let enableDisabled = $derived(enablePassword.length === 0 || enabling);
  let verifyDisabled = $derived(verifyCode.trim().length < 4 || verifying);
  let disableDisabled = $derived(disablePassword.length === 0 || disabling);

  async function startEnable(event: SubmitEvent) {
    event.preventDefault();
    if (enableDisabled) return;
    enabling = true;
    try {
      const res = await api<{ totpURI: string | null; backupCodes: string[] }>(
        "/api/me/2fa/enable",
        {
          method: "POST",
          body: JSON.stringify({ password: enablePassword }),
        },
      );
      if (!res.totpURI) {
        throw new ApiError(500, "2fa_enable_failed", "No TOTP URI returned.");
      }
      totpUri = res.totpURI;
      backupCodes = res.backupCodes;
      try {
        manualSecret = new URLSearchParams(new URL(res.totpURI).search).get("secret") ?? "";
      } catch {
        manualSecret = "";
      }
      qrDataUrl = await QRCode.toDataURL(res.totpURI, { width: 220, margin: 1 });
      step = "confirm";
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not enable 2FA.");
    } finally {
      enabling = false;
      enablePassword = "";
    }
  }

  async function confirmEnable(event: SubmitEvent) {
    event.preventDefault();
    if (verifyDisabled) return;
    verifying = true;
    try {
      await api("/api/me/2fa/verify", {
        method: "POST",
        body: JSON.stringify({ code: verifyCode.trim() }),
      });
      twoFactorEnabled = true;
      step = "idle";
      totpUri = "";
      qrDataUrl = "";
      backupCodes = [];
      manualSecret = "";
      verifyCode = "";
      toastSuccess("Two-factor authentication is now active.");
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Invalid code. Try again.");
    } finally {
      verifying = false;
    }
  }

  function cancelEnable() {
    step = "idle";
    totpUri = "";
    qrDataUrl = "";
    backupCodes = [];
    manualSecret = "";
    verifyCode = "";
    enablePassword = "";
    toastInfo(
      "2FA was not confirmed. Re-enable to generate a new secret and code.",
    );
  }

  async function disable2fa(event: SubmitEvent) {
    event.preventDefault();
    if (disableDisabled) return;
    disabling = true;
    try {
      await api("/api/me/2fa/disable", {
        method: "POST",
        body: JSON.stringify({ password: disablePassword }),
      });
      twoFactorEnabled = false;
      disablePassword = "";
      toastSuccess("Two-factor authentication turned off.");
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not disable 2FA.");
    } finally {
      disabling = false;
    }
  }

  async function addPasskey() {
    addingPasskey = true;
    const { error: err } = await authClient.passkey.addPasskey({
      name: newPasskeyName.trim() || undefined,
    });
    addingPasskey = false;
    if (err) {
      const msg = (err.message ?? "").toLowerCase();
      if (!msg.includes("abort") && !msg.includes("cancel")) {
        toastError(err.message ?? "Could not register passkey.");
      }
      return;
    }
    newPasskeyName = "";
    await refreshPasskeys();
    toastSuccess("Passkey added.");
  }

  async function removePasskey(id: string) {
    deletingId = id;
    try {
      await api(`/api/me/passkeys/${id}`, { method: "DELETE" });
      passkeys = passkeys.filter((p) => p.id !== id);
      toastSuccess("Passkey removed.");
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : "Could not remove passkey.");
    } finally {
      deletingId = null;
    }
  }

  async function refreshPasskeys() {
    try {
      const res = await api<{ passkeys: PasskeyRow[] }>("/api/me/passkeys");
      passkeys = res.passkeys;
    } catch {
      // keep current list on failure
    }
  }

  function fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  }
</script>

<svelte:head>
  <title>Security — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-10">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Security</h1>
    <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
      Protect your account with two-factor authentication and passkeys.
    </p>
  </header>

  <!-- Two-factor authentication -->
  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Two-factor authentication"
  >
    <div class="flex items-center gap-2">
      <ShieldCheck class="size-5 text-neutral-500" />
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Two-factor authentication (authenticator app)
      </h2>
    </div>

    {#if twoFactorEnabled && step === "idle"}
      <p class="mt-3 text-sm">
        <span
          class="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        >
          Enabled
        </span>
        <span class="ml-2 text-neutral-600 dark:text-neutral-400">
          You'll need a code from your authenticator app at every sign-in.
        </span>
      </p>
      <form class="mt-4 flex flex-col gap-3 sm:max-w-md" onsubmit={disable2fa} novalidate>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Confirm password to disable</span>
          <input
            type="password"
            autocomplete="current-password"
            bind:value={disablePassword}
            class="input px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={disableDisabled}
          class="self-start rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
        >
          {disabling ? "Disabling…" : "Disable 2FA"}
        </button>
      </form>
    {:else if step === "confirm"}
      <div class="mt-4 flex flex-col gap-5">
        <p class="text-sm">
          Scan this QR with your authenticator app (Google Authenticator, Authy,
          1Password, etc.), then enter the 6-digit code it shows to finish.
        </p>
        {#if qrDataUrl}
          <img src={qrDataUrl} alt="TOTP enrollment QR code" class="size-56 rounded-lg border border-neutral-200 dark:border-neutral-800" />
        {/if}
        {#if manualSecret}
          <p class="text-xs text-neutral-600 dark:text-neutral-400">
            Can't scan? Enter this key manually:
            <code class="ml-1 break-all rounded bg-neutral-100 px-1.5 py-0.5 font-mono dark:bg-neutral-900">{manualSecret}</code>
          </p>
        {/if}
        {#if backupCodes.length}
          <div class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
            <p class="font-medium text-amber-900 dark:text-amber-200">Save these backup codes</p>
            <p class="mt-1 text-amber-800 dark:text-amber-300">
              Use each once if you lose your authenticator. Store them somewhere safe.
            </p>
            <ul class="mt-3 grid grid-cols-2 gap-1 font-mono text-sm">
              {#each backupCodes as code}
                <li>{code}</li>
              {/each}
            </ul>
          </div>
        {/if}
        <form class="flex flex-col gap-3 sm:max-w-md" onsubmit={confirmEnable} novalidate>
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Verification code</span>
            <input
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              bind:value={verifyCode}
              class="input px-3 py-2 font-mono tracking-[0.3em]"
              placeholder="123456"
              maxlength="10"
            />
          </label>
          <div class="flex gap-2">
            <button
              type="submit"
              disabled={verifyDisabled}
              class="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {verifying ? "Verifying…" : "Confirm and enable"}
            </button>
            <button
              type="button"
              onclick={cancelEnable}
              class="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    {:else}
      <p class="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
        Add a second factor: after your password, you'll enter a rotating code
        from an authenticator app.
      </p>
      <form class="mt-4 flex flex-col gap-3 sm:max-w-md" onsubmit={startEnable} novalidate>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Confirm password to enable</span>
          <input
            type="password"
            autocomplete="current-password"
            bind:value={enablePassword}
            class="input px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={enableDisabled}
          class="self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {enabling ? "Preparing…" : "Enable 2FA"}
        </button>
      </form>
    {/if}
  </section>

  <!-- Passkeys -->
  <section
    class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    aria-label="Passkeys"
  >
    <div class="flex items-center gap-2">
      <KeyRound class="size-5 text-neutral-500" />
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Passkeys</h2>
    </div>
    <p class="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
      Sign in instantly with Face ID, Touch ID, or a hardware key. Passwordless
      and phishing-resistant.
    </p>

    <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
      <label class="flex flex-1 flex-col gap-1 text-sm">
        <span class="font-medium">Label (optional)</span>
        <input
          type="text"
          bind:value={newPasskeyName}
          class="input px-3 py-2"
          placeholder="e.g. MacBook, iPhone"
        />
      </label>
      <button
        type="button"
        onclick={addPasskey}
        disabled={addingPasskey}
        class="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {addingPasskey ? "Waiting for passkey…" : "Add passkey"}
      </button>
    </div>

    {#if passkeys.length === 0}
      <p class="mt-4 text-sm text-neutral-500">No passkeys registered yet.</p>
    {:else}
      <ul class="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
        {#each passkeys as pk (pk.id)}
          <li class="flex items-center justify-between py-3">
            <div>
              <p class="text-sm font-medium">{pk.name || "Unnamed passkey"}</p>
              <p class="text-xs text-neutral-500">
                {pk.deviceType}{#if pk.backedUp}<span> · synced</span>{/if}
                <span> · added {fmtDate(pk.createdAt)}</span>
              </p>
            </div>
            <button
              type="button"
              onclick={() => removePasskey(pk.id)}
              disabled={deletingId === pk.id}
              class="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              aria-label="Remove passkey"
            >
              <Trash2 class="size-3.5" />
              {deletingId === pk.id ? "Removing…" : "Remove"}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>

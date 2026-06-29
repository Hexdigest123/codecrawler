<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { ApiError, api } from "$lib/api";
  import { PLAN_LABEL, type SsoConfig, type SsoProvider } from "$lib/types";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const existing = $derived<SsoConfig | null>(data.sso ?? null);
  const existingConfig = $derived<Record<string, unknown>>(
    existing?.config ?? {},
  );
  const isPro = $derived(data.team?.plan === "pro");
  const isAdmin = $derived(
    data.team?.role === "owner" || data.team?.role === "admin",
  );

  let providerId = $state<SsoProvider>("saml");
  let domain = $state("");
  let entryURL = $state("");
  let entityId = $state("");
  let certificate = $state("");
  let signInURL = $state("");
  let clientId = $state("");
  let clientSecret = $state("");
  let issuerUrl = $state("");
  let scopes = $state("");

  let saving = $state(false);
  let deleting = $state(false);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);

  const samlCertConfigured = $derived(Boolean(existingConfig.certificate));
  const oidcSecretConfigured = $derived(Boolean(existingConfig.clientSecret));

  $effect.pre(() => {
    providerId = existing?.providerId ?? "saml";
    domain = existing?.domain ?? "";
    entryURL = stringField(existingConfig.entryURL);
    entityId = stringField(existingConfig.entityId);
    signInURL = stringField(existingConfig.signInURL);
    clientId = stringField(existingConfig.clientId);
    issuerUrl = stringField(existingConfig.issuerUrl);
    scopes = stringField(existingConfig.scopes);
    certificate = "";
    clientSecret = "";
  });

  function stringField(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  function providerLabel(p: SsoProvider): string {
    return p === "saml" ? "SAML 2.0" : "OIDC";
  }

  const samlRequiredMet = $derived(
    entryURL.trim().length > 0 &&
    entityId.trim().length > 0 &&
    (certificate.trim().length > 0 || samlCertConfigured),
  );

  const oidcRequiredMet = $derived(
    clientId.trim().length > 0 &&
    issuerUrl.trim().length > 0 &&
    (clientSecret.length > 0 || oidcSecretConfigured),
  );

  const canSave = $derived(
    domain.trim().length > 0 &&
    (providerId === "saml" ? samlRequiredMet : oidcRequiredMet) &&
    !saving,
  );

  function buildConfig(): Record<string, unknown> {
    if (providerId === "saml") {
      const cfg: Record<string, unknown> = {
        entryURL: entryURL.trim(),
        entityId: entityId.trim(),
      };
      if (signInURL.trim().length > 0) cfg.signInURL = signInURL.trim();
      if (certificate.trim().length > 0) cfg.certificate = certificate.trim();
      return cfg;
    }
    const cfg: Record<string, unknown> = {
      clientId: clientId.trim(),
      issuerUrl: issuerUrl.trim(),
    };
    if (scopes.trim().length > 0) cfg.scopes = scopes.trim();
    if (clientSecret.length > 0) cfg.clientSecret = clientSecret;
    return cfg;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!canSave) return;
    saving = true;
    error = null;
    success = null;
    try {
      await api<{ ok: boolean }>(`/api/teams/${data.teamId}/sso`, {
        method: "POST",
        body: JSON.stringify({
          domain: domain.trim(),
          providerId,
          config: buildConfig(),
        }),
      });
      success = "SSO configuration saved.";
      await invalidateAll();
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not save SSO.";
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!existing) return;
    if (
      !confirm(
        "Remove this SSO configuration? Team members will sign in with email and password.",
      )
    )
      return;
    deleting = true;
    error = null;
    success = null;
    try {
      await api<{ ok: boolean }>(`/api/teams/${data.teamId}/sso`, {
        method: "DELETE",
      });
      success = "SSO configuration removed.";
      await invalidateAll();
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not remove SSO.";
    } finally {
      deleting = false;
    }
  }
</script>

<svelte:head>
  <title>Single sign-on — {data.team?.organization?.name ?? "Team"} — CodeCrawler</title>
</svelte:head>

<section class="flex flex-col gap-8">
  <header>
    <div class="flex items-center gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">Single sign-on</h1>
      <span
        class="rounded-full border border-neutral-300 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700"
      >
        {data.team ? PLAN_LABEL[data.team.plan] : "—"}
      </span>
    </div>
    <p class="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
      Connect an identity provider so team members sign in with SSO. A "Sign in with SSO"
      button on the sign-in page resolves the provider by email domain.
    </p>
  </header>

  {#if !isPro || data.needsUpgrade}
    <section
      class="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800"
      aria-label="Pro feature"
    >
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-lg font-semibold">Custom SSO is a Pro feature</h2>
          <p class="mt-1 max-w-xl text-sm text-neutral-600 dark:text-neutral-400">
            SAML 2.0 and OIDC single sign-on keep your team on your identity provider
            (Okta, Entra, Google Workspace and more). Upgrade to Pro to configure it.
          </p>
        </div>
        <a
          href={`/teams/${data.teamId}/settings/billing`}
          class="shrink-0 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
        >
          Upgrade to Pro
        </a>
      </div>
    </section>
  {:else if !isAdmin}
    <section
      class="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800"
      aria-label="Restricted"
    >
      <h2 class="text-lg font-semibold">Admins only</h2>
      <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Only team owners and admins can configure single sign-on. Ask an admin to make
        changes.
      </p>
    </section>
  {:else}
    {#if existing}
      <section
        class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
        aria-label="Current configuration"
      >
        <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Current configuration
        </h2>
        <dl class="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <dt class="text-xs uppercase tracking-wide text-neutral-400">Provider</dt>
            <dd class="mt-1 text-lg font-semibold">{providerLabel(existing.providerId)}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-neutral-400">Domain</dt>
            <dd class="mt-1 text-lg font-semibold">{existing.domain}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-neutral-400">Secrets</dt>
            <dd class="mt-1 text-sm font-medium text-neutral-600 dark:text-neutral-300">
              {#if existing.providerId === "saml"}
                Certificate {samlCertConfigured ? "configured" : "not set"}
              {:else}
                Client secret {oidcSecretConfigured ? "configured" : "not set"}
              {/if}
            </dd>
          </div>
        </dl>
        <div class="mt-5">
          <button
            type="button"
            onclick={remove}
            disabled={deleting}
            class="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 bg-white hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-neutral-900 dark:hover:bg-red-950"
          >
            {deleting ? "Removing…" : "Remove SSO"}
          </button>
        </div>
      </section>
    {/if}

    {#if error}
      <p
        role="alert"
        class="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
      >
        {error}
      </p>
    {/if}
    {#if success}
      <p
        role="status"
        class="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
      >
        {success}
      </p>
    {/if}

    <form
      class="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
      onsubmit={save}
      novalidate
    >
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        {existing ? "Update configuration" : "Configure SSO"}
      </h2>

      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Provider</span>
          <select
            bind:value={providerId}
            class="input px-3 py-2"
          >
            <option value="saml">SAML 2.0</option>
            <option value="oidc">OIDC</option>
          </select>
        </label>

        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Email domain</span>
          <input
            type="text"
            bind:value={domain}
            placeholder="yourcompany.com"
            class="input px-3 py-2"
          />
          <span class="text-xs text-neutral-500">
            The org email domain that triggers this SSO provider.
          </span>
        </label>
      </div>

      {#if providerId === "saml"}
        <div class="mt-5 grid gap-4">
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">IdP SSO URL</span>
            <input
              type="url"
              bind:value={entryURL}
              placeholder="https://idp.example.com/app/sso/saml"
              class="input px-3 py-2"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Entity ID</span>
            <input
              type="text"
              bind:value={entityId}
              placeholder="https://idp.example.com/entity"
              class="input px-3 py-2"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Certificate</span>
            <textarea
              bind:value={certificate}
              rows="5"
              placeholder={samlCertConfigured
                ? "Configured — leave blank to keep the current certificate."
                : "-----BEGIN CERTIFICATE-----"}
              class="input px-3 py-2 font-mono text-xs"
            ></textarea>
            <span class="text-xs text-neutral-500">
              The IdP's signing certificate (PEM). Never shown after saving.
            </span>
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Sign-in URL <span class="font-normal text-neutral-400">(optional)</span></span>
            <input
              type="url"
              bind:value={signInURL}
              placeholder="https://idp.example.com/login"
              class="input px-3 py-2"
            />
          </label>
        </div>
      {:else}
        <div class="mt-5 grid gap-4 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Client ID</span>
            <input
              type="text"
              bind:value={clientId}
              placeholder="your-client-id"
              class="input px-3 py-2"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Client secret</span>
            <input
              type="password"
              autocomplete="off"
              bind:value={clientSecret}
              placeholder={oidcSecretConfigured
                ? "Configured — leave blank to keep the current secret."
                : "your-client-secret"}
              class="input px-3 py-2"
            />
            <span class="text-xs text-neutral-500">Never shown after saving.</span>
          </label>
          <label class="flex flex-col gap-1 text-sm sm:col-span-2">
            <span class="font-medium">Issuer URL (well-known)</span>
            <input
              type="url"
              bind:value={issuerUrl}
              placeholder="https://idp.example.com"
              class="input px-3 py-2"
            />
            <span class="text-xs text-neutral-500">
              Discovery is read from <code>{"{issuer}/.well-known/openid-configuration"}</code>.
            </span>
          </label>
          <label class="flex flex-col gap-1 text-sm sm:col-span-2">
            <span class="font-medium">Scopes <span class="font-normal text-neutral-400">(optional)</span></span>
            <input
              type="text"
              bind:value={scopes}
              placeholder="openid email profile"
              class="input px-3 py-2"
            />
          </label>
        </div>
      {/if}

      <p class="mt-5 rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        SSO is validated structurally; a live IdP login is tested separately.
      </p>

      <div class="mt-5 flex items-center gap-4">
        <button
          type="submit"
          disabled={!canSave}
          class="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : existing ? "Save changes" : "Enable SSO"}
        </button>
      </div>
    </form>
  {/if}
</section>

// Litellm tests cover provider catalog behavior.
import {
  capturePluginRegistration,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
});

type LitellmCatalogProviders = NonNullable<
  NonNullable<Parameters<typeof runProviderCatalog>[0]["config"]>["models"]
>["providers"];

const cases: Array<{
  name: string;
  providers: LitellmCatalogProviders;
  endpoint: string;
  expectedBaseUrl: string;
}> = [
  {
    name: "versioned explicit base URL",
    providers: { litellm: { baseUrl: "https://litellm.example/v1", models: [] } },
    endpoint: "https://litellm.example/v1/models",
    expectedBaseUrl: "https://litellm.example/v1",
  },
  {
    name: "versioned explicit base URL with a trailing slash",
    providers: { litellm: { baseUrl: "https://litellm.example/v1/", models: [] } },
    endpoint: "https://litellm.example/v1/models",
    expectedBaseUrl: "https://litellm.example/v1/",
  },
  {
    name: "versioned base URL under a differently cased provider key",
    providers: { LiteLLM: { baseUrl: "https://litellm.example/v1", models: [] } },
    endpoint: "https://litellm.example/v1/models",
    expectedBaseUrl: "https://litellm.example/v1",
  },
  {
    name: "unversioned explicit base URL",
    providers: { litellm: { baseUrl: "http://127.0.0.1:4000", models: [] } },
    endpoint: "http://127.0.0.1:4000/v1/models",
    expectedBaseUrl: "http://127.0.0.1:4000",
  },
  {
    name: "default unversioned base URL",
    providers: {},
    endpoint: "http://localhost:4000/v1/models",
    expectedBaseUrl: "http://localhost:4000",
  },
];

it.each(cases)(
  "registered LiteLLM catalog.run requests $endpoint for the $name",
  async ({ providers, endpoint, expectedBaseUrl }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      input === endpoint
        ? Response.json({ data: [{ id: "stub-model-alpha" }], object: "list" })
        : new Response("Not Found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const captured = capturePluginRegistration(plugin);
    const provider = captured.providers[0];
    expect(provider?.id).toBe("litellm");
    if (!provider) {
      throw new Error("litellm provider was not registered");
    }
    const profileId = "litellm:default";
    const result = await runProviderCatalog({
      provider,
      config: {
        models: {
          providers,
        },
      },
      env: {},
      resolveProviderApiKey: () => ({
        apiKey: "litellm-test-key",
        discoveryApiKey: "litellm-test-key",
        profileId,
      }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(endpoint);
    expect(result).toMatchObject({
      provider: {
        baseUrl: expectedBaseUrl,
        models: [expect.objectContaining({ id: "stub-model-alpha" })],
      },
      outcomes: [{ provider: "litellm", profileId, status: "ready" }],
    });
  },
);

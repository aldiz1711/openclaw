// Litellm provider module implements model/runtime integration.
import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildLitellmModelDefinition, LITELLM_BASE_URL } from "./onboard.js";

export function buildLitellmProvider(): ModelProviderConfig {
  return {
    baseUrl: LITELLM_BASE_URL,
    api: "openai-completions",
    models: [buildLitellmModelDefinition()],
  };
}

export function buildLitellmModelDiscovery(baseUrl: string): OpenAICompatibleModelDiscoveryOptions {
  return {
    endpointPath: isVersionedLitellmBaseUrl(baseUrl) ? "models" : "v1/models",
  };
}

function isVersionedLitellmBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, "").endsWith("/v1");
  } catch {
    return false;
  }
}

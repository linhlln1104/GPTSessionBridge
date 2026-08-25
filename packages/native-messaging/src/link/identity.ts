export const BRIDGE_IMPLEMENTATION_VERSION = "0.1.0" as const;

/**
 * Development-only host identity. Keeping HKCU development registration on a
 * separate key prevents it from shadowing a future signed production host.
 */
export const NATIVE_MESSAGING_HOST_NAME = "com.gptsessionbridge.native_host.dev" as const;

/**
 * Public development identity pinned by the manifest key. Release packaging
 * must replace this pair with the Chrome Web Store item identity.
 */
export const DEVELOPMENT_EXTENSION_ID = "bhladcjpjnimikahacopaghedecjmjfn" as const;
export const DEVELOPMENT_EXTENSION_ORIGIN =
  `chrome-extension://${DEVELOPMENT_EXTENSION_ID}/` as const;

export const NATIVE_MESSAGING_HOST_NAME = "com.gptsessionbridge.native_host" as const;

/**
 * Public development identity pinned by the manifest key. Release packaging
 * must replace this pair with the Chrome Web Store item identity.
 */
export const DEVELOPMENT_EXTENSION_ID = "bhladcjpjnimikahacopaghedecjmjfn" as const;
export const DEVELOPMENT_EXTENSION_ORIGIN =
  `chrome-extension://${DEVELOPMENT_EXTENSION_ID}/` as const;

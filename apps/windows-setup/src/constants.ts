export const DEVELOPMENT_EXTENSION_ID = "bhladcjpjnimikahacopaghedecjmjfn" as const;
export const DEVELOPMENT_EXTENSION_ORIGIN =
  `chrome-extension://${DEVELOPMENT_EXTENSION_ID}/` as const;
export const DEVELOPMENT_NATIVE_HOST_NAME = "com.gptsessionbridge.native_host.dev" as const;
export const NATIVE_HOST_DESCRIPTION =
  "GPTSessionBridge Native Messaging host (development)" as const;
export const PACKAGE_MANIFEST_FILENAME = "package-manifest.json" as const;
export const PACKAGE_MANIFEST_SCHEMA_VERSION = 2 as const;
export const DEVELOPMENT_FACADE_EXECUTABLE_PATH =
  "native-host/gptsessionbridge-facade.exe" as const;
export const DEVELOPMENT_HOST_EXECUTABLE_PATH =
  "native-host/gptsessionbridge-native-host.exe" as const;
export const DEVELOPMENT_HELPER_EXECUTABLE_PATH =
  "native-host/gptsessionbridge-windows-ipc.exe" as const;
export const DEVELOPMENT_HOST_TEMPLATE_PATH = "native-host/chrome-windows.template.json" as const;
export const DEVELOPMENT_EXTENSION_MANIFEST_PATH = "extension/manifest.json" as const;
export const NATIVE_HOST_EXECUTABLE_PLACEHOLDER =
  "__GPTSESSIONBRIDGE_NATIVE_HOST_EXECUTABLE__" as const;
export const REGISTRY_KEY_PREFIX = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts" as const;

export const DEVELOPMENT_INSTALL_COMPONENTS = Object.freeze([
  "Programs",
  "GPTSessionBridge",
  "dev",
]);

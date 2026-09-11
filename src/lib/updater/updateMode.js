export function getUpdateSource(env = process.env) {
  const source = env?.UPDATE_SOURCE;
  if (!source) return "npm";
  if (source === "npm" || source === "external") return source;
  return "invalid";
}

export function isExternalUpdateSource(env = process.env) {
  return getUpdateSource(env) === "external";
}

export function buildExternalVersionResponse(packageVersion) {
  return {
    updateSource: "external",
    currentVersion: packageVersion,
    latestVersion: null,
    hasUpdate: false,
    managedExternally: true,
  };
}

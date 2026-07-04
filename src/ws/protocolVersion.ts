/** Gateway speaks protocol v1.x; any other major version is incompatible. */
const SUPPORTED_MAJOR = 1;

export function isCompatibleProtocolVersion(version: string): boolean {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return major === SUPPORTED_MAJOR;
}

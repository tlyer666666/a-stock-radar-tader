// Consumer boundary for persisted or remotely supplied securities.
export const isUsableSecurity = (value: unknown): value is Security => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.code !== "string" || !/^\d{6}$/.test(row.code) ||
      typeof row.name !== "string" || !row.name.trim() ||
      typeof row.secid !== "string" || !row.secid.trim()) return false;
  if (["thscode", "marketName"].some(key => row[key] !== undefined && typeof row[key] !== "string")) return false;
  if (row.defaultVisible !== undefined && typeof row.defaultVisible !== "boolean") return false;
  return row.assetType === undefined || ["stock", "etf", "convertibleBond"].includes(String(row.assetType));
};

// An intentionally empty primary is authoritative. Mixed primaries keep usable
// recent rows; only an entirely unusable primary should fall back to a backup.
export const isUsableSecurityCollection = (value: unknown): value is Security[] =>
  Array.isArray(value) && (value.length === 0 || value.some(isUsableSecurity));

export const uniqueSecurities = (value: unknown): Security[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((row): row is Security => {
    if (!isUsableSecurity(row) || seen.has(row.code)) return false;
    seen.add(row.code);
    return true;
  });
};

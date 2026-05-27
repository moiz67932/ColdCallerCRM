export function getSupabaseRuntimeFingerprint() {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const parsed = parseUrl(supabaseUrl);
  const hostname = parsed?.hostname ?? "";

  return {
    supabase_url_hostname: hostname,
    supabase_project_ref: hostname.endsWith(".supabase.co") ? hostname.split(".")[0] : "",
    node_env: process.env.NODE_ENV ?? "",
    vercel_env: process.env.VERCEL_ENV ?? "",
  };
}

function parseUrl(value: string) {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

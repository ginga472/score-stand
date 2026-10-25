// Supabase project for sync. Both values are public by design: the URL and the
// publishable (anon) key only identify the project. What protects your data is
// Row Level Security on the server (see supabase/schema.sql), not secrecy here.
// Never put the service_role key in this file.
// If you change SUPABASE_URL, also update connect-src in index.html's CSP.
export const SUPABASE_URL = 'https://wmaofvonemfhqsyfesof.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_e17Lps_hlM_JxYHQ5GXmJw_fC6tQUQC';

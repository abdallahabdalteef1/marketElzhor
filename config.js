// Supabase project settings.
// The publishable key is PUBLIC by design: all data access is protected by Row Level Security on the server.
// NEVER put a secret / service_role key or any WhatsApp token in this folder.
export const SUPABASE_URL = 'https://rneacjzxtavmexbxkcbu.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_lG5Z71pYd9F8l-Iv3Wauyw__votBGVk';
export const IS_CONFIGURED = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');

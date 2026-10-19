// The account's backend (Supabase). Both values are public, like in any web app: what keeps the
// data safe is the sign-in and the row level security of each table (see supabase/schema.sql).
// Empty values leave the account out: the projects are only kept on this device.
export const SUPABASE_URL = '';
export const SUPABASE_KEY = ''; // the project's publishable (anon) key — never the secret one

// The desktop app signs in through the system browser, which comes back to this port on the
// computer (it must be among the account's Redirect URLs: http://127.0.0.1:47811/**).
export const LOGIN_PORT = 47811;

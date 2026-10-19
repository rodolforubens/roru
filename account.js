// The user's account (Supabase): signing in with Google, and the client the projects are kept
// through (see projects.js). On the web page the sign-in goes through the page itself; in the
// desktop app it goes through the system browser (Google doesn't sign in inside an app's own
// window), which comes back to a port on this computer where the backend waits for it.
import { createClient } from './vendor/supabase.js?v=6e0ce12';
import { SUPABASE_URL, SUPABASE_KEY, LOGIN_PORT } from './config.js?v=6e0ce12';
import { desktop, invoke } from './platform.js?v=6e0ce12';

export const configured = !!(SUPABASE_URL && SUPABASE_KEY);

export const db = configured ? createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: !desktop, persistSession: true, autoRefreshToken: true, storageKey: 'roru.auth' },
}) : null;

let user = null;
const listeners = new Set();

export const currentUser = () => user;

// `fn(user)` runs when the user signs in or out (user is null when signed out).
export const onAccount = fn => listeners.add(fn);

let failure = null;

// Why the sign-in the web page just came back from failed (e.g. it took too long), or null.
export const signInFailure = () => failure;

// Reads the session kept from the last time (on the web, also the one a sign-in just came back with).
export async function initAccount() {
  if (!db) return null;
  const { data } = await db.auth.getSession();
  user = data.session?.user ?? null;
  // the sign-in came back with a code (or why it failed) in the address: it's been used, so it goes away
  const back = desktop ? null : new URLSearchParams(location.search);
  if (back?.has('code') || back?.has('error')) {
    failure = back.get('error') ? back.get('error_description') || back.get('error') : null;
    history.replaceState(null, '', location.pathname);
  }
  db.auth.onAuthStateChange((_event, session) => {
    const next = session?.user ?? null;
    if (next?.id === user?.id) { user = next; return; } // the session was only refreshed
    user = next;
    // not from inside the callback: Supabase calls made there would wait for it to finish
    setTimeout(() => listeners.forEach(fn => fn(user)));
  });
  return user;
}

export async function signIn() {
  if (!db) throw new Error('The account is not set up (see config.js)');
  const queryParams = { prompt: 'select_account' };
  if (!desktop) {
    const { error } = await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams } });
    if (error) throw error;
    return; // the page goes to Google and comes back signed in
  }
  const { data, error } = await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `http://127.0.0.1:${LOGIN_PORT}/`, skipBrowserRedirect: true, queryParams },
  });
  if (error) throw error;
  const back = invoke('wait_for_login', { port: LOGIN_PORT });
  await invoke('open_url', { url: data.url });
  const query = new URLSearchParams(await back);
  if (!query.get('code')) throw new Error(query.get('error_description') || query.get('error') || 'The sign-in was not completed');
  const done = await db.auth.exchangeCodeForSession(query.get('code'));
  if (done.error) throw done.error;
}

// Signs out of this device only (the other devices stay signed in).
export async function signOut() {
  await db?.auth.signOut({ scope: 'local' });
}

export const userName = u => u?.user_metadata?.full_name || u?.user_metadata?.name || u?.email || '';
export const userAvatar = u => u?.user_metadata?.avatar_url || u?.user_metadata?.picture || '';

// js/supabase.js — Supabase client + thin auth helpers (design §13).
// Only spesa_* tables are ever touched (by sync.js). Anon key only; security via RLS.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = 'https://dzxnmexvregajijjseqt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_E77K0UCQ5FPkGwChJE541A_5KO3ii8U';

// Session persistence in localStorage, but under an APP-SPECIFIC storageKey so
// this app's session is isolated from the OTHER PWA on the same Supabase project
// and same origin. By default supabase-js stores the auth token under a shared
// key derived only from the project ref ('sb-<ref>-auth-token'); two apps on the
// same origin + project would then read/write the SAME session, so login/logout
// in one leaks into the other. A distinct storageKey keeps the two sessions
// independent (the other app keeps the default key — they just must differ).
// NOTE: changing this key logs this app out ONCE (the old session lives under the
// previous key); re-login once and it stays separate thereafter.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storageKey: 'indispesabile-auth',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// Thin helpers: forward and return supabase's { data, error } unchanged.
export const signUp = (email, password) => supabase.auth.signUp({ email, password });
export const signIn = (email, password) => supabase.auth.signInWithPassword({ email, password });
export const signOut = () => supabase.auth.signOut();
export const resetPassword = (email) =>
  supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
export const getSession = () => supabase.auth.getSession();
export const onAuthStateChange = (cb) => supabase.auth.onAuthStateChange(cb);

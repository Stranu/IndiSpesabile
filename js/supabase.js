// js/supabase.js — Supabase client + thin auth helpers (design §13).
// Only spesa_* tables are ever touched (by sync.js). Anon key only; security via RLS.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = 'https://dzxnmexvregajijjseqt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_E77K0UCQ5FPkGwChJE541A_5KO3ii8U';

// Default session persistence (localStorage) — session survives reloads.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Thin helpers: forward and return supabase's { data, error } unchanged.
export const signUp = (email, password) => supabase.auth.signUp({ email, password });
export const signIn = (email, password) => supabase.auth.signInWithPassword({ email, password });
export const signOut = () => supabase.auth.signOut();
export const getSession = () => supabase.auth.getSession();
export const getUser = () => supabase.auth.getUser();
export const onAuthStateChange = (cb) => supabase.auth.onAuthStateChange(cb);

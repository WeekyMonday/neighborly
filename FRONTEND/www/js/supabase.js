// =========================================================================
// ECHO — Supabase client (frontend)
// Safe to expose in the browser: the anon key only works within the
// permissions granted by your Row Level Security (RLS) policies.
// Never put the secret/service_role key in this file.
// =========================================================================

const SUPABASE_URL = "https://sepzgimwjjztilqbtkfs.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNlcHpnaW13amp6dGlscWJ0a2ZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1NjE5NDgsImV4cCI6MjEwMTEzNzk0OH0.GMKkjudMKm7gpTmOfHAqpuNVEsl-1NFLmp-6hEvrz_I";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- Shared auth helpers used across login.html / register.html / forgot-password.html / index.html ----

async function echoSignUp(email, password, displayName) {
  return await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName }
    }
  });
}

async function echoSignIn(email, password) {
  return await supabase.auth.signInWithPassword({ email, password });
}

async function echoSignOut() {
  return await supabase.auth.signOut();
}

async function echoGetSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session;
}

async function echoRequestPasswordReset(email) {
  // redirectTo should point at the page in your app that will handle the
  // recovery link Supabase emails out (commonly forgot-password.html or a
  // dedicated update-password.html). Adjust the path to match your host.
  return await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + "/update-password.html"
  });
}

// Verifies the 5-6 digit recovery code the user typed in. This only works
// if your Supabase project's "Reset Password" email template uses the
// {{ .Token }} variable (a short code) rather than {{ .ConfirmationURL }}
// (a clickable link). Check Authentication > Email Templates in your
// Supabase dashboard if this call keeps failing with an "invalid token" error.
async function echoVerifyRecoveryOtp(email, token) {
  return await supabase.auth.verifyOtp({ email, token, type: 'recovery' });
}

async function echoUpdatePassword(newPassword) {
  return await supabase.auth.updateUser({ password: newPassword });
}

// Redirect to login.html if there's no active session. Call this at the
// top of any page that should be gated behind auth (e.g. index.html).
async function echoRequireAuth() {
  const session = await echoGetSession();
  if (!session) {
    window.location.href = "login.html";
    return null;
  }
  return session;
}

// Redirect away from login/register if the user is already signed in.
async function echoRedirectIfAuthed(destination) {
  const session = await echoGetSession();
  if (session) {
    window.location.href = destination || "index.html";
  }
}
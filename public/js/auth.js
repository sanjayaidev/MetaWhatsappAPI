// public/js/auth.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Initialize Supabase Client (Public/Anon key only)
const supabase = createClient('YOUR_SUPABASE_URL', 'YOUR_SUPABASE_ANON_KEY');

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;

            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            
            if (error) {
                alert('Login failed: ' + error.message);
            } else {
                // Save token for API calls
                localStorage.setItem('supabase_token', data.session.access_token);
                localStorage.setItem('user_id', data.user.id);
                window.location.href = '/dashboard.html';
            }
        });
    }

    // Social Login Buttons
    const googleBtn = document.getElementById('google-login');
    if (googleBtn) {
        googleBtn.addEventListener('click', async () => {
            const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + '/dashboard.html' } });
            if (error) alert(error.message);
        });
    }
});

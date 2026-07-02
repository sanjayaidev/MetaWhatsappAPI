// public/js/dashboard.js
document.addEventListener('DOMContentLoaded', async () => {
    // Check auth
    const token = localStorage.getItem('supabase_token');
    if (!token) window.location.href = '/login.html';

    // Load WhatsApp Accounts
    const accountsRes = await API.getAccounts();
    if (accountsRes.success) {
        const container = document.getElementById('wa-accounts-list');
        container.innerHTML = accountsRes.accounts.map(acc => `
            <div class="account-card">
                <h3>${acc.display_name}</h3>
                <p>${acc.phone_number}</p>
                <span class="badge ${acc.quality_rating.toLowerCase()}">${acc.quality_rating}</span>
            </div>
        `).join('');
    }

    // Example: Connect New Number Flow
    const connectBtn = document.getElementById('connect-wa-btn');
    if (connectBtn) {
        connectBtn.addEventListener('click', async () => {
            const waba_id = prompt('Enter WABA ID:');
            const access_token = prompt('Enter System User Access Token:');
            
            if (waba_id && access_token) {
                // 1. Verify
                const verifyRes = await API.verifyWaNumber(waba_id, access_token);
                if (verifyRes.success && verifyRes.numbers.length > 0) {
                    const phone_id = verifyRes.numbers[0].phone_number_id;
                    // 2. Save
                    const saveRes = await API.saveWaNumber({ waba_id, phone_number_id: phone_id, access_token });
                    if (saveRes.success) alert('Number connected!');
                } else {
                    alert('Verification failed: ' + (verifyRes.error || 'No numbers found'));
                }
            }
        });
    }
});

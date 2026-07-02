// public/js/api.js

// Generic API call helper
async function apiCall(endpoint, method = 'GET', body = null, requireAuth = true) {
    const headers = { 'Content-Type': 'application/json' };
    
    if (requireAuth) {
        const token = localStorage.getItem('supabase_token');
        if (!token) {
            window.location.href = '/login.html'; // Redirect if not logged in
            return;
        }
        headers['Authorization'] = `Bearer ${token}`;
    }

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    try {
        const res = await fetch(`${API_BASE_URL}${endpoint}`, options);
        const data = await res.json();
        
        if (res.status === 401) {
            localStorage.removeItem('supabase_token');
            window.location.href = '/login.html';
        }
        
        return data;
    } catch (err) {
        console.error(`API Error [${endpoint}]:`, err);
        return { error: err.message };
    }
}

// Specific API functions
const API = {
    // Auth
    login: (email, password) => apiCall('/auth/v1/token?grant_type=password', 'POST', { email, password }, false),
    
    // WhatsApp Accounts
    getAccounts: () => apiCall('/api/wa/accounts'),
    verifyWaNumber: (waba_id, access_token) => apiCall('/api/wa/manual/verify', 'POST', { waba_id, access_token }, false),
    saveWaNumber: (data) => apiCall('/api/wa/manual/save', 'POST', data),
    
    // Campaigns
    createCampaign: (data) => apiCall('/api/campaigns', 'POST', data),
    startCampaign: (id) => apiCall(`/api/campaigns/${id}/start`, 'POST'),
    pauseCampaign: (id) => apiCall(`/api/campaigns/${id}/pause`, 'POST'),
    stopCampaign: (id) => apiCall(`/api/campaigns/${id}/stop`, 'POST'),
    getCampaignStatus: (id) => apiCall(`/api/campaigns/${id}/status`),
    
    // Contacts & Templates (You may need to add these routes to server.js if not already there)
    getContacts: () => apiCall('/api/contacts'),
    getTemplates: () => apiCall('/api/templates'),
};

// src/push.js
//
// Sends FCM push notifications to a user's registered Android devices when
// a new WhatsApp message comes in. Used as a low-latency nudge on top of the
// existing 30s poll in mobile.html — not a replacement for it, since FCM
// delivery isn't 100% guaranteed on every device/OEM.
//
// Requires the `firebase-admin` package and a Firebase service account.
// Set FIREBASE_SERVICE_ACCOUNT_JSON in the environment to the full JSON
// contents of that service account key (single-line, e.g. via
// `cat key.json | jq -c .` when setting the env var on Render/etc).

let admin = null;
let initError = null;

function getAdmin() {
  if (admin || initError) return admin;
  try {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
      const serviceAccount = JSON.parse(raw);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    return admin;
  } catch (e) {
    initError = e;
    console.error('[push] firebase-admin not configured, pushes will be skipped:', e.message);
    return null;
  }
}

// Sends a data-only message (no `notification` block) so the app's
// FirebaseMessagingService.onMessageReceived always fires — in both
// foreground and background — and decides itself whether to refresh the
// open WebView or show a native notification, rather than letting the OS
// auto-display it while the app is backgrounded.
async function sendNewMessagePush(supabase, userId, { phone, contactName, body }) {
  const fbAdmin = getAdmin();
  if (!fbAdmin) return;

  const { data: devices, error } = await supabase
    .from('wb_device_tokens')
    .select('id, fcm_token')
    .eq('user_id', userId);
  if (error || !devices?.length) return;

  const message = {
    data: {
      type: 'new_message',
      phone: phone || '',
      contact_name: contactName || '',
      preview: (body || '').slice(0, 120)
    },
    tokens: devices.map(d => d.fcm_token)
  };

  try {
    const result = await fbAdmin.messaging().sendEachForMulticast(message);
    // Clean up tokens Firebase reports as no-longer-registered (uninstalled
    // app, token rotated without re-registering, etc.) so the device list
    // doesn't grow stale.
    const deadTokenIds = [];
    result.responses.forEach((r, i) => {
      if (!r.success && (r.error?.code === 'messaging/registration-token-not-registered')) {
        deadTokenIds.push(devices[i].id);
      }
    });
    if (deadTokenIds.length) {
      await supabase.from('wb_device_tokens').delete().in('id', deadTokenIds);
    }
  } catch (e) {
    console.error('[push] send failed:', e.message);
  }
}

module.exports = { sendNewMessagePush };
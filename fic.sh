#!/usr/bin/env bash
# fix.sh — adds a persistent phone->name directory (wb_known_contacts),
# decoupled from the ephemeral campaign contact list (wb_contacts).
#
# Run this from the root of your MetaWhatsappAPI checkout (the folder
# containing server.js, package.json, public/, migrations/).
#
# What it does:
#   1. Adds migrations/007_known_contacts.sql
#   2. server.js:
#        - campaign contact upload also seeds wb_known_contacts, but only
#          for phones that don't already have a saved name
#        - new POST /api/known-contacts endpoint for manually saving a
#          name from the inbox (this one DOES overwrite — explicit action)
#        - handleIncomingMessage's sender-name lookup now reads from
#          wb_known_contacts instead of wb_contacts
#   3. public/mobile.html:
#        - "save name" (✏️) button in the thread header, shown only when
#          the open contact has no saved name yet
#        - saveContactName() function wired up to the new endpoint
#
# Safe to re-run: each edit checks the target file already contains the
# expected surrounding text before changing anything, and skips with a
# clear message if it's already applied or doesn't match (e.g. you're on
# a different version of the file than these patches expect).

set -e

if [ ! -f server.js ] || [ ! -d public ] || [ ! -d migrations ]; then
  echo "❌ Run this from the root of your MetaWhatsappAPI checkout (expected server.js, public/, migrations/ here)."
  exit 1
fi

echo "→ Adding migrations/007_known_contacts.sql"
if [ -f migrations/007_known_contacts.sql ]; then
  echo "  already exists, skipping"
else
cat > migrations/007_known_contacts.sql << 'SQL_EOF'
-- ═══════════════════════════════════════════════════════════════
-- WaBlast Pro CRM — Migration 007
-- Adds wb_known_contacts: a persistent phone -> name directory used
-- purely for display (Inbox sender names), decoupled from wb_contacts
-- (which is a campaign audience list that gets fully deleted and
-- replaced every time a new contact list is uploaded).
-- Run this AFTER 001.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wb_known_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_wb_known_contacts_user_phone ON wb_known_contacts(user_id, phone);

COMMENT ON TABLE wb_known_contacts IS 'Persistent phone->name directory for display purposes only (Inbox sender names). Unlike wb_contacts, never bulk-deleted by campaign uploads.';
SQL_EOF
  echo "  done — remember to run this against your database"
fi

echo "→ Patching server.js and public/mobile.html"
python3 << 'PYEOF'
import sys

def patch(path, old, new, label):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    if new in content:
        print(f"  skip ({label}): already applied")
        return
    count = content.count(old)
    if count == 0:
        print(f"  ⚠️  skip ({label}): expected text not found — may already differ from what this patch expects. Check manually.")
        return
    if count > 1:
        print(f"  ⚠️  skip ({label}): expected text found {count} times (not unique) — check manually.")
        return
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content.replace(old, new, 1))
    print(f"  ✓ applied: {label}")

# --- server.js: 1) seed known-contacts on campaign upload, only if missing ---
patch('server.js',
old="""  const { error } = await supabase.from('wb_contacts').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  
  // Return saved contacts""",
new="""  const { error } = await supabase.from('wb_contacts').insert(rows);
  if (error) return res.status(500).json({ error: error.message });

  // Feed names into the persistent phone->name directory too, but only
  // for numbers that don't already have one saved — a campaign list
  // shouldn't be able to overwrite a name someone already saved from the
  // inbox (e.g. a blank/wrong name column in a sloppy CSV upload).
  // ignoreDuplicates: true means "insert if missing, skip if the
  // (user_id, phone) pair already exists" rather than overwriting.
  try {
    await supabase.from('wb_known_contacts').upsert(
      rows.map(r => ({ user_id: r.user_id, phone: r.phone, name: r.name, updated_at: new Date().toISOString() })),
      { onConflict: 'user_id,phone', ignoreDuplicates: true }
    );
  } catch (e) {
    console.error('[contacts] failed to update known-contacts directory:', e.message);
  }

  // Return saved contacts""",
label="server.js: seed wb_known_contacts on campaign upload")

# --- server.js: 2) new manual save-name endpoint ---
patch('server.js',
old="""  res.json({ success: true, contacts: data || [] });
});

// ================================================================
// 9. SETTINGS ROUTES""",
new="""  res.json({ success: true, contacts: data || [] });
});

// Persistent phone->name directory, used for Inbox sender display and
// never touched by the campaign upload/delete cycle above. This one DOES
// overwrite on conflict — unlike the campaign-upload feed-in, this is a
// deliberate, explicit action from the person using the app, so it should
// win over whatever a stale campaign list previously guessed at.
app.post('/api/known-contacts', verifyUser, async (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone || !name?.trim()) return res.status(400).json({ error: 'phone and name are required' });

  const { error } = await supabase.from('wb_known_contacts').upsert(
    {
      user_id: req.user.id,
      phone: String(phone).replace(/\\D/g, ''),
      name: name.trim(),
      updated_at: new Date().toISOString()
    },
    { onConflict: 'user_id,phone' }
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ================================================================
// 9. SETTINGS ROUTES""",
label="server.js: new POST /api/known-contacts endpoint")

# --- server.js: 3) sender-name lookup reads from wb_known_contacts ---
patch('server.js',
old="""  // Try to match the sender to a saved contact so the Received tab can show a name.
  let contactName = '';
  try {
    const { data: contact } = await supabase
      .from('wb_contacts')
      .select('name')
      .eq('user_id', waAccount.user_id)
      .eq('phone', msg.from)
      .single();
    if (contact?.name) contactName = contact.name;
  } catch (_) { /* no matching contact, that's fine */ }""",
new="""  // Try to match the sender to a saved name so the Received tab can show
  // one. Uses wb_known_contacts (persistent) rather than wb_contacts
  // (a campaign audience list that gets fully wiped and replaced every
  // time a new contact list is uploaded, or once a campaign completes).
  let contactName = '';
  try {
    const { data: contact } = await supabase
      .from('wb_known_contacts')
      .select('name')
      .eq('user_id', waAccount.user_id)
      .eq('phone', msg.from)
      .single();
    if (contact?.name) contactName = contact.name;
  } catch (_) { /* no matching contact, that's fine */ }""",
label="server.js: sender-name lookup now uses wb_known_contacts")

# --- mobile.html: 1) save-name button in thread header ---
patch('public/mobile.html',
old="""        <div class="tinfo">
          <div class="name" id="threadName">Contact</div>
          <div class="status" id="threadStatus">via WhatsApp</div>
        </div>
        <button class="icon-btn" style="font-size:16px;">⋯</button>""",
new="""        <div class="tinfo">
          <div class="name" id="threadName">Contact</div>
          <div class="status" id="threadStatus">via WhatsApp</div>
        </div>
        <button class="icon-btn" id="saveNameBtn" title="Save name" onclick="saveContactName()" style="display:none;">✏️</button>
        <button class="icon-btn" style="font-size:16px;">⋯</button>""",
label="mobile.html: save-name button in thread header")

# --- mobile.html: 2) toggle button visibility in renderThread ---
patch('public/mobile.html',
old="""  document.getElementById('threadName').textContent = c.name;
  document.getElementById('threadStatus').textContent = c.messages.length > 0 ? 'Last message: ' + formatTime(c.messages[c.messages.length-1].at) : 'via WhatsApp';""",
new="""  document.getElementById('threadName').textContent = c.name;
  // c.name falls back to the phone number itself when the server has no
  // saved name for this sender (see API.getMessages), so that's the
  // signal for "nothing saved yet, show the save-name button".
  document.getElementById('saveNameBtn').style.display = (c.name === c.phone) ? '' : 'none';
  document.getElementById('threadStatus').textContent = c.messages.length > 0 ? 'Last message: ' + formatTime(c.messages[c.messages.length-1].at) : 'via WhatsApp';""",
label="mobile.html: toggle save-name button visibility")

# --- mobile.html: 3) saveContactName() function ---
patch('public/mobile.html',
old="""async function manualRefresh() {
  const btn = document.getElementById('refreshBtn');
  if (btn.classList.contains('spinning')) return; // already refreshing, ignore extra taps
  btn.classList.add('spinning');
  try {
    await loadChats();
  } finally {
    btn.classList.remove('spinning');
  }
}""",
new="""async function manualRefresh() {
  const btn = document.getElementById('refreshBtn');
  if (btn.classList.contains('spinning')) return; // already refreshing, ignore extra taps
  btn.classList.add('spinning');
  try {
    await loadChats();
  } finally {
    btn.classList.remove('spinning');
  }
}

// Saves a display name for the currently open thread's sender into the
// persistent phone->name directory (wb_known_contacts) — separate from
// the campaign contact list, so it survives future campaign uploads.
async function saveContactName() {
  const c = state.conversations.find(x => x.phone === state.currentPhone);
  if (!c) return;
  const name = prompt('Save name for ' + c.phone);
  if (!name || !name.trim()) return;

  const res = await apiCall('/api/known-contacts', 'POST', { phone: c.phone, name: name.trim() });
  if (res.success) {
    c.name = name.trim();
    renderThread();
    renderChatList();
  } else {
    alert('Could not save name. Please try again.');
  }
}""",
label="mobile.html: saveContactName() function")

PYEOF

echo "→ Checking server.js syntax"
node --check server.js && echo "  ✓ server.js OK"

echo ""
echo "Done. Remaining manual step: run migrations/007_known_contacts.sql against your database."
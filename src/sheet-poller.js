// src/sheet-poller.js — polling-based sheet automation (see migrations/002_sheet_watchers.sql).
//
// Runs on a plain setInterval tick (no extra dependency needed — the repo has
// no job-queue/cron package installed). Every tick, each active wb_sheet_watchers
// row whose poll_interval_minutes has elapsed gets re-read from Google Sheets:
//
//   - watch_type = 'new_row'       -> any row appended since the last poll
//                                     triggers message_template as a send.
//   - watch_type = 'date_reminder' -> any row whose date_column lands on
//                                     today (adjusted by offset_days) and
//                                     hasn't already fired this year gets
//                                     message_template as a "wish" send.
//
// This intentionally reuses the existing lead-capture + channel-send pipeline
// (same one webhooks-inbound.js uses) so sheet-triggered sends show up in the
// CRM like any other lead/message, rather than being a side channel.
const TICK_MS = 60 * 1000; // check every minute; each watcher still only actually polls Sheets every poll_interval_minutes
const SHEETS_VALUE_RANGE = (worksheet) => `${worksheet}!A1:ZZ5000`;

function startSheetPoller(deps) {
  const { supabase, fetch, sendChannelMessage } = deps;
  const { getValidGoogleAccessToken } = require('./google-auth')(deps);

  async function tick() {
    const { data: watchers, error } = await supabase.from('wb_sheet_watchers').select('*').eq('active', true);
    if (error) { console.error('[sheet-poller] failed to load watchers:', error.message); return; }

    for (const watcher of watchers || []) {
      const dueAt = watcher.last_polled_at ? new Date(watcher.last_polled_at).getTime() + watcher.poll_interval_minutes * 60 * 1000 : 0;
      if (Date.now() < dueAt) continue; // not due yet
      pollWatcher(watcher).catch(err => console.error(`[sheet-poller] watcher ${watcher.id} failed:`, err.message));
    }
  }

  async function pollWatcher(watcher) {
    let accessToken;
    try {
      accessToken = await getValidGoogleAccessToken(watcher.user_id);
    } catch (err) {
      await markError(watcher, err.message);
      return;
    }

    const range = SHEETS_VALUE_RANGE(watcher.worksheet);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${watcher.spreadsheet_id}/values/${encodeURIComponent(range)}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (!res.ok) {
      await markError(watcher, data.error?.message || `Sheets API error ${res.status}`);
      return;
    }

    const rows = data.values || [];
    const headers = (rows[0] || []).map(h => String(h || '').trim());
    const dataRows = rows.slice(1);
    const colIndex = (headerName) => headers.findIndex(h => h.toLowerCase() === String(headerName || '').trim().toLowerCase());

    if (watcher.watch_type === 'new_row') {
      await pollNewRows(watcher, headers, dataRows, colIndex);
    } else if (watcher.watch_type === 'date_reminder') {
      await pollDateReminders(watcher, headers, dataRows, colIndex);
    }
  }

  async function pollNewRows(watcher, headers, dataRows, colIndex) {
    const currentCount = dataRows.length;
    const newRows = currentCount > watcher.last_row_count ? dataRows.slice(watcher.last_row_count) : [];

    for (const row of newRows) {
      try {
        await sendForRow(watcher, headers, row, colIndex);
      } catch (err) {
        console.error(`[sheet-poller] new_row send failed for watcher ${watcher.id}:`, err.message);
      }
    }

    await supabase.from('wb_sheet_watchers').update({
      last_row_count: currentCount, last_polled_at: new Date().toISOString(), last_error: null
    }).eq('id', watcher.id);
  }

  async function pollDateReminders(watcher, headers, dataRows, colIndex) {
    const dateIdx = colIndex(watcher.date_column);
    if (dateIdx === -1) {
      await markError(watcher, `Date column "${watcher.date_column}" not found in sheet headers`);
      return;
    }

    const today = new Date();
    const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
    const firedLog = { ...(watcher.fired_log || {}) };
    let changed = false;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rawDate = row[dateIdx];
      const parsed = parseFlexibleDate(rawDate);
      if (!parsed) continue;

      // Recurring annually: check both "this year" and "next year" occurrence of
      // month/day, each shifted back by offset_days, against today.
      const isReminderDay = [today.getFullYear(), today.getFullYear() + 1].some(year => {
        const occurrence = new Date(year, parsed.getMonth(), parsed.getDate());
        occurrence.setDate(occurrence.getDate() - (watcher.offset_days || 0));
        return occurrence.getFullYear() === today.getFullYear() && occurrence.getMonth() === today.getMonth() && occurrence.getDate() === today.getDate();
      });
      if (!isReminderDay) continue;

      const rowKey = String(i);
      if (firedLog[rowKey] === todayKey) continue; // already sent today (dedupe against multiple ticks same day)
      // Also guard against firing again if we've already fired for this same calendar event this year
      const lastFiredYear = firedLog[rowKey] ? firedLog[rowKey].split('-')[0] : null;
      if (lastFiredYear === String(today.getFullYear())) continue;

      try {
        await sendForRow(watcher, headers, row, colIndex);
        firedLog[rowKey] = todayKey;
        changed = true;
      } catch (err) {
        console.error(`[sheet-poller] date_reminder send failed for watcher ${watcher.id} row ${i}:`, err.message);
      }
    }

    const patch = { last_polled_at: new Date().toISOString(), last_error: null };
    if (changed) patch.fired_log = firedLog;
    await supabase.from('wb_sheet_watchers').update(patch).eq('id', watcher.id);
  }

  // Renders message_template against a sheet row (using column headers as merge
  // tags), finds-or-creates a wb_leads row so it's visible in the CRM, and sends
  // through the same channel pipeline manual replies / automations use. For
  // WhatsApp this always goes out as the watcher's approved template — Meta
  // rejects free-text business-initiated messages outside a live chat window.
  async function sendForRow(watcher, headers, row, colIndex) {
    const mergeFields = {};
    headers.forEach((h, idx) => { if (h) mergeFields[h] = row[idx] ?? ''; });

    const name = watcher.name_column ? row[colIndex(watcher.name_column)] : undefined;
    const phone = watcher.phone_column ? row[colIndex(watcher.phone_column)] : undefined;
    const email = watcher.email_column ? row[colIndex(watcher.email_column)] : undefined;
    mergeFields.name = name || '';
    mergeFields.phone = phone || '';
    mergeFields.email = email || '';

    if (!phone && !email) return; // nothing to send to

    const lead = await findOrCreateLead(watcher.user_id, { name, phone, email });

    if (watcher.channel === 'whatsapp') {
      const { template, previewBody } = await buildWhatsAppTemplatePayload(watcher, mergeFields);
      await sendChannelMessage({ lead, channel: 'whatsapp', body: previewBody, isAutomation: true, template });
      return;
    }

    const body = String(watcher.message_template || '').replace(/\{(\w+)\}/g, (_, key) => mergeFields[key] ?? `{${key}}`);
    await sendChannelMessage({ lead, channel: watcher.channel, body, isAutomation: true });
  }

  // Resolves the watcher's placeholder_mapping (same shape used by campaigns:
  // { "1": {type:'name'}, "2": {type:'field', field:'Amount'}, ... }) against
  // this row's merge fields, and returns a Meta template payload + a
  // human-readable preview string for the CRM message log.
  async function buildWhatsAppTemplatePayload(watcher, mergeFields) {
    const { data: tpl, error } = await supabase.from('wb_templates').select('*').eq('id', watcher.template_id).single();
    if (error || !tpl) throw new Error('Linked template not found — pick a template again on this watcher');

    const resolveValue = (map) => {
      if (map.type === 'name') return mergeFields.name || '';
      if (map.type === 'phone') return mergeFields.phone || '';
      if (map.type === 'email') return mergeFields.email || '';
      if (map.type === 'field') return mergeFields[map.field] ?? '';
      if (map.type === 'custom') return map.value || '';
      return '';
    };

    const entries = Object.entries(watcher.placeholder_mapping || {});
    const isPositional = entries.length > 0 && entries.every(([key]) => /^\d+$/.test(key));

    let params = [];
    let previewBody = tpl.body || '';
    if (isPositional) {
      params = entries
        .map(([key, map]) => ({ position: parseInt(key, 10), text: String(resolveValue(map)) }))
        .sort((a, b) => a.position - b.position)
        .map(({ text }) => ({ type: 'text', text }));
      entries.forEach(([key, map]) => { previewBody = previewBody.replace(`{{${key}}}`, String(resolveValue(map))); });
    } else {
      params = entries.map(([key, map]) => ({ type: 'text', parameter_name: key, text: String(resolveValue(map)) }));
      entries.forEach(([key, map]) => { previewBody = previewBody.replace(`{{${key}}}`, String(resolveValue(map))); });
    }

    const template = { name: tpl.name, language: { code: tpl.language || 'en_US' } };
    if (params.length) template.components = [{ type: 'BODY', parameters: params }];

    return { template, previewBody };
  }

  async function findOrCreateLead(userId, { name, phone, email }) {
    let query = supabase.from('wb_leads').select('*').eq('user_id', userId);
    query = phone ? query.eq('phone', phone) : query.eq('email', email);
    const { data: existing } = await query.limit(1).maybeSingle();
    if (existing) return existing;

    const { data: created, error } = await supabase.from('wb_leads').insert({
      user_id: userId, name, phone, email, primary_source: 'sheet'
    }).select().single();
    if (error) throw new Error(error.message);
    return created;
  }

  async function markError(watcher, message) {
    console.error(`[sheet-poller] watcher ${watcher.id}:`, message);
    await supabase.from('wb_sheet_watchers').update({
      last_error: message, last_polled_at: new Date().toISOString()
    }).eq('id', watcher.id);
  }

  // Parses common date formats found in Google Sheets values output:
  // ISO (YYYY-MM-DD), slash-separated (assumes DD/MM/YYYY — the more common
  // convention outside the US; adjust here if your sheets use MM/DD/YYYY),
  // and raw Sheets serial-date numbers (days since 1899-12-30).
  function parseFlexibleDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value).trim())) {
      const serial = parseFloat(value);
      const epoch = new Date(Date.UTC(1899, 11, 30));
      return new Date(epoch.getTime() + serial * 86400000);
    }
    const str = String(value).trim();
    const slashMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (slashMatch) {
      let [, d, m, y] = slashMatch;
      if (y.length === 2) y = `20${y}`;
      const date = new Date(Number(y), Number(m) - 1, Number(d));
      if (!isNaN(date.getTime())) return date;
    }
    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  setInterval(() => tick().catch(err => console.error('[sheet-poller] tick error:', err.message)), TICK_MS);
  console.log('[sheet-poller] started — checking due watchers every 60s');
}

module.exports = { startSheetPoller };
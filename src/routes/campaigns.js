// src/routes/campaigns.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { decryptToken } = require('../crypto');
const fetch = require('node-fetch');

const META_API_VERSION = 'v20.0';

// Create Campaign
router.post('/', async (req, res) => {
    const user_id = req.user.id;
    const { name, template_id, group_name } = req.body;

    if (!name) return res.status(400).json({ error: 'Campaign name required' });
    if (!template_id) return res.status(400).json({ error: 'template_id required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const activeRes = await client.query(
            "SELECT id, name, status FROM wb_campaigns WHERE user_id = $1 AND status IN ('queued', 'running', 'paused') LIMIT 1",
            [user_id]
        );
        if (activeRes.rows.length > 0) {
            return res.status(400).json({ error: `Campaign "${activeRes.rows[0].name}" is already ${activeRes.rows[0].status}.` });
        }

        const tplRes = await client.query("SELECT id, name, status, language FROM wb_templates WHERE id = $1 AND user_id = $2", [template_id, user_id]);
        if (tplRes.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
        const tpl = tplRes.rows[0];
        if (tpl.status !== 'APPROVED') return res.status(400).json({ error: 'Template must be APPROVED' });

        let contactQuery = "SELECT * FROM wb_contacts WHERE user_id = $1";
        let queryParams = [user_id];
        if (group_name?.trim()) {
            contactQuery += " AND group_name = $2";
            queryParams.push(group_name.trim());
        }
        const contactsRes = await client.query(contactQuery, queryParams);
        if (contactsRes.rows.length === 0) return res.status(400).json({ error: 'No contacts found' });

        const profileRes = await client.query("SELECT credits FROM wb_profiles WHERE id = $1", [user_id]);
        const credits = profileRes.rows[0]?.credits || 0;
        if (credits < contactsRes.rows.length) {
            return res.status(400).json({ error: `Insufficient credits. Need ${contactsRes.rows.length}, have ${credits}` });
        }

        await client.query("UPDATE wb_profiles SET credits = credits - $1, updated_at = NOW() WHERE id = $2", [contactsRes.rows.length, user_id]);

        const campRes = await client.query(
            `INSERT INTO wb_campaigns (user_id, name, template_id, template_name, group_name, status, total_contacts, queue_total)
             VALUES ($1, $2, $3, $4, $5, 'queued', $6, $6) RETURNING *`,
            [user_id, name, tpl.id, tpl.name, group_name?.trim() || null, contactsRes.rows.length]
        );
        const campaign = campRes.rows[0];

        const queueItems = contactsRes.rows.map(c => ([
            campaign.id, user_id, c.id, c.phone, c.name || '', tpl.name, tpl.language || 'en_US', 'pending', 0
        ]));
        
        const insertQuery = `
            INSERT INTO wb_send_queue (campaign_id, user_id, contact_id, phone, contact_name, template_name, template_language, status, attempt_count)
            VALUES ${queueItems.map((_, i) => `($${i*9+1}, $${i*9+2}, $${i*9+3}, $${i*9+4}, $${i*9+5}, $${i*9+6}, $${i*9+7}, $${i*9+8}, $${i*9+9})`).join(',')}
        `;
        await client.query(insertQuery, queueItems.flat());

        await client.query('COMMIT');
        res.json({ success: true, campaign, total_contacts: contactsRes.rows.length });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Start Campaign
router.post('/:id/start', async (req, res) => {
    const { id } = req.params;
    const user_id = req.user.id;
    await pool.query("UPDATE wb_campaigns SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1 AND user_id = $2", [id, user_id]);
    res.json({ success: true, message: 'Campaign started' });
});

// Pause Campaign
router.post('/:id/pause', async (req, res) => {
    const { id } = req.params;
    const user_id = req.user.id;
    await pool.query("UPDATE wb_campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1 AND user_id = $2", [id, user_id]);
    res.json({ success: true, message: 'Campaign paused' });
});

// Stop Campaign (Refund credits)
router.post('/:id/stop', async (req, res) => {
    const { id } = req.params;
    const user_id = req.user.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const countRes = await client.query("SELECT COUNT(*) FROM wb_send_queue WHERE campaign_id = $1 AND status = 'pending'", [id]);
        const pendingCount = parseInt(countRes.rows[0].count);

        await client.query("DELETE FROM wb_send_queue WHERE campaign_id = $1 AND status = 'pending'", [id]);
        if (pendingCount > 0) {
            await client.query("UPDATE wb_profiles SET credits = credits + $1, updated_at = NOW() WHERE id = $2", [pendingCount, user_id]);
        }
        await client.query("UPDATE wb_campaigns SET status = 'draft', updated_at = NOW() WHERE id = $1 AND user_id = $2", [id, user_id]);
        await client.query('COMMIT');
        res.json({ success: true, refunded: pendingCount });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Get Status
router.get('/:id/status', async (req, res) => {
    const { id } = req.params;
    const user_id = req.user.id;
    const campRes = await pool.query("SELECT * FROM wb_campaigns WHERE id = $1 AND user_id = $2", [id, user_id]);
    if (campRes.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    const campaign = campRes.rows[0];

    const pendingRes = await pool.query("SELECT COUNT(*) FROM wb_send_queue WHERE campaign_id = $1 AND status = 'pending'", [id]);
    const pending = parseInt(pendingRes.rows[0].count);

    let next_send_at = null;
    let gap_seconds = 0;

    if (campaign.status === 'running' && campaign.sent_count > 0) {
        const settingsRes = await pool.query("SELECT max_gap FROM wb_settings WHERE user_id = $1", [user_id]);
        const maxGap = settingsRes.rows[0]?.max_gap || 15;
        const lastSentRes = await pool.query("SELECT sent_at FROM wb_send_queue WHERE campaign_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1", [id]);
        
        if (lastSentRes.rows.length > 0 && lastSentRes.rows[0].sent_at) {
            const secondsSinceLast = (Date.now() - new Date(lastSentRes.rows[0].sent_at).getTime()) / 1000;
            if (secondsSinceLast < maxGap) {
                gap_seconds = Math.max(0, Math.ceil(maxGap - secondsSinceLast));
                next_send_at = new Date(Date.now() + gap_seconds * 1000).toISOString();
            }
        }
    }

    res.json({ success: true, status: campaign.status, total: campaign.queue_total, sent: campaign.queue_processed, failed: campaign.queue_failed, pending, next_send_at, gap_seconds });
});

// ================================================================
// INTERNAL QUEUE PROCESSOR (Runs natively in Node.js every 3s)
// ================================================================
async function processQueue() {
    const runningRes = await pool.query("SELECT id, user_id FROM wb_campaigns WHERE status = 'running'");
    if (runningRes.rows.length === 0) return { processed: 0 };

    const runningIds = runningRes.rows.map(r => r.id);
    const pendingRes = await pool.query(
        `SELECT * FROM wb_send_queue WHERE status = 'pending' AND campaign_id = ANY($1) ORDER BY created_at ASC LIMIT 1`,
        [runningIds]
    );

    if (pendingRes.rows.length === 0) return { processed: 0 };
    const queueItem = pendingRes.rows[0];

    const settingsRes = await pool.query("SELECT min_gap, max_gap FROM wb_settings WHERE user_id = $1", [queueItem.user_id]);
    const minGap = settingsRes.rows[0]?.min_gap || 5;
    const maxGap = settingsRes.rows[0]?.max_gap || 15;
    const randomGap = minGap + Math.random() * (maxGap - minGap);

    const lastSentRes = await pool.query(
        `SELECT sent_at FROM wb_send_queue WHERE campaign_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`,
        [queueItem.campaign_id]
    );

    if (lastSentRes.rows.length > 0 && lastSentRes.rows[0].sent_at) {
        const secondsSinceLast = (Date.now() - new Date(lastSentRes.rows[0].sent_at).getTime()) / 1000;
        if (secondsSinceLast < randomGap) {
            return { processed: 0, action: 'gap_wait', wait_seconds: Math.ceil(randomGap - secondsSinceLast) };
        }
    }

    const waRes = await pool.query(
        `SELECT * FROM wa_accounts WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1`,
        [queueItem.user_id]
    );

    if (waRes.rows.length === 0) {
        await pool.query(`UPDATE wb_send_queue SET status = 'failed', error_reason = 'No WhatsApp account connected', processed_at = NOW() WHERE id = $1`, [queueItem.id]);
        await updateCampaignProgress(queueItem.campaign_id, false);
        return { processed: 1, failed: 1 };
    }

    const waAccount = waRes.rows[0];
    await pool.query("UPDATE wb_send_queue SET status = 'processing', processed_at = NOW() WHERE id = $1", [queueItem.id]);

    const payload = {
        messaging_product: 'whatsapp',
        to: queueItem.phone,
        type: 'template',
        template: { name: queueItem.template_name, language: { code: queueItem.template_language } }
    };

    let sendSuccess = false;
    let waMessageId = null;
    let errorMsg = null;

    try {
        const plainToken = decryptToken(waAccount.access_token);
        const result = await fetch(
            `https://graph.facebook.com/${META_API_VERSION}/${waAccount.phone_number_id}/messages`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plainToken}` },
                body: JSON.stringify(payload)
            }
        );
        const responseData = await result.json();
        if (result.ok && responseData.messages?.[0]?.id) {
            waMessageId = responseData.messages[0].id;
            sendSuccess = true;
        } else {
            errorMsg = responseData.error?.message || `Meta API ${result.status}`;
        }
    } catch (err) {
        errorMsg = err.message;
    }

    await pool.query(
        `UPDATE wb_send_queue SET status = $1, wa_message_id = $2, error_reason = $3, sent_at = $4, attempt_count = attempt_count + 1 WHERE id = $5`,
        [sendSuccess ? 'sent' : 'failed', waMessageId, errorMsg, sendSuccess ? new Date().toISOString() : null, queueItem.id]
    );

    if (sendSuccess && waMessageId) {
        await pool.query(
            `INSERT INTO wb_campaign_logs (campaign_id, queue_id, wa_message_id, delivery_status) VALUES ($1, $2, $3, 'sent')`,
            [queueItem.campaign_id, queueItem.id, waMessageId]
        );
    }

    await updateCampaignProgress(queueItem.campaign_id, sendSuccess);
    return { processed: 1, sent: sendSuccess ? 1 : 0, failed: sendSuccess ? 0 : 1, phone: queueItem.phone };
}

async function updateCampaignProgress(campaignId, sendSuccess) {
    const campRes = await pool.query("SELECT queue_processed, queue_failed, queue_total, status FROM wb_campaigns WHERE id = $1", [campaignId]);
    if (campRes.rows.length === 0) return;
    const campaign = campRes.rows[0];
    if (campaign.status === 'paused') return;

    const newProcessed = (campaign.queue_processed || 0) + (sendSuccess ? 1 : 0);
    const newFailed = (campaign.queue_failed || 0) + (sendSuccess ? 0 : 1);
    const newStatus = (newProcessed + newFailed) >= campaign.queue_total ? 'completed' : campaign.status;

    await pool.query(
        `UPDATE wb_campaigns SET queue_processed = $1, queue_failed = $2, status = $3, sent_count = $1, failed_count = $2, completed_at = $4, updated_at = NOW() WHERE id = $5`,
        [newProcessed, newFailed, newStatus, newStatus === 'completed' ? new Date().toISOString() : null, campaignId]
    );
}

module.exports = router;
module.exports.processQueue = processQueue; // Export for server.js interval

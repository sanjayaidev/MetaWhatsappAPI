const express = require('express');
const { requireAuth } = require('../lib/auth');
const { decrypt } = require('../lib/crypto');

// Keep in sync with routes/connections.js / platforms/*.js — different
// platforms issue tokens for different hosts and a token from one is NOT
// valid on another. Mixing these up is what produces Graph's
// "(#100) Cannot parse access token" error, since the host doesn't
// recognize the token format/issuer at all (this is unrelated to which
// app id/secret was used to obtain the token).
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v25.0';
const THREADS_VERSION = process.env.THREADS_VERSION || 'v1.0';
const FB_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const IG_BASE = 'https://graph.instagram.com';
const THREADS_BASE = `https://graph.threads.net/${THREADS_VERSION}`;

// Instagram can be connected two ways (see platforms/instagram.js):
//  1. Facebook Login for Business -> page_id is set -> token only works on graph.facebook.com
//  2. Direct Instagram Login       -> page_id is null -> token only works on graph.instagram.com
// Mirrors the exact same logic platforms/instagram.js uses for posting/replies/DMs.
function instagramHosts(connection) {
    const primary = connection.page_id ? FB_BASE : IG_BASE;
    const fallback = connection.page_id ? IG_BASE : FB_BASE;
    return { primary, fallback };
}

// Build a URL with properly encoded params. Access tokens routinely contain
// characters like +, /, =, & that are NOT safe to paste into a URL via plain
// template-string interpolation — doing so can truncate/corrupt the token
// and Graph responds with "(#100) Cannot parse access token" even when the
// host and token are otherwise correct. URLSearchParams (like axios's
// `params` option used elsewhere in this codebase) handles this correctly.
function buildUrl(base, path, params) {
    const qs = new URLSearchParams(params).toString();
    return `${base}${path}?${qs}`;
}

async function fetchGraph(url) {
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
        const err = new Error(data.error.message || 'Graph API error');
        err.graphError = data.error;
        err.status = response.status;
        throw err;
    }

    return data;
}

// Try the primary host, and fall back to the secondary host only for
// auth/host-mismatch style errors (matches the codes platforms/instagram.js
// already treats as "try the other host": #3, #100, #190, 401, 403).
async function fetchWithHostFallback(hosts, path, params) {
    const isHostMismatchError = (err) => {
        const code = err.graphError?.code;
        return code === 3 || code === 100 || code === 190 || err.status === 401 || err.status === 403;
    };

    try {
        return await fetchGraph(buildUrl(hosts.primary, path, params));
    } catch (err) {
        if (!hosts.fallback || !isHostMismatchError(err)) throw err;
        console.log(`Insights call failed on ${hosts.primary}${path} (code ${err.graphError?.code}), retrying on ${hosts.fallback}...`);
        return fetchGraph(buildUrl(hosts.fallback, path, params));
    }
}

// Fetch a set of insights metrics, tolerating individual invalid/unavailable
// metric names instead of failing the whole request. Meta frequently
// deprecates or renames metrics, so if the full batch is rejected with
// "must be a valid insights metric" we retry metric-by-metric and just omit
// whichever ones fail, rather than surfacing 0s for everything.
async function fetchMetricsResilient(hosts, nodeId, metrics, accessToken, extraParams = {}, edge = 'insights') {
    const metricList = metrics.join(',');
    try {
        const data = await fetchWithHostFallback(hosts, `/${nodeId}/${edge}`, {
            metric: metricList,
            access_token: accessToken,
            ...extraParams
        });
        return data.data || [];
    } catch (err) {
        const isInvalidMetric = err.graphError?.code === 100 && /insights metric/i.test(err.graphError?.message || '');
        if (!isInvalidMetric) throw err;

        const results = [];
        for (const metric of metrics) {
            try {
                const data = await fetchWithHostFallback(hosts, `/${nodeId}/${edge}`, {
                    metric,
                    access_token: accessToken,
                    ...extraParams
                });
                results.push(...(data.data || []));
            } catch (metricErr) {
                console.error(`Skipping invalid/unsupported metric "${metric}" for ${nodeId}:`, metricErr.graphError?.message || metricErr.message);
            }
        }
        return results;
    }
}

function toMetricsMap(items) {
    const metrics = {};
    items.forEach(item => {
        if (item.values && item.values.length > 0) {
            metrics[item.name] = item.values[item.values.length - 1].value;
        } else if (typeof item.total_value?.value !== 'undefined') {
            metrics[item.name] = item.total_value.value;
        }
    });
    return metrics;
}

module.exports = function insightsRouter(pool) {
    const router = express.Router();

    // Apply authentication to all routes
    router.use(requireAuth);

    // GET /api/insights/account - Account-level insights
    router.get('/account', async (req, res) => {
        try {
            const { platform } = req.query;

            if (!platform || !['instagram', 'facebook', 'threads'].includes(platform)) {
                return res.status(400).json({ error: 'Invalid platform' });
            }

            // Get user's connections for this platform
            const userId = req.user.id || req.user.sub;
            const connectionsResult = await pool.query(
                "SELECT * FROM connections WHERE user_id = $1 AND platform = $2 AND is_connected = true",
                [userId, platform]
            );

            if (connectionsResult.rows.length === 0) {
                return res.status(404).json({ error: 'No connected accounts found for this platform' });
            }

            const connection = connectionsResult.rows[0];
            const pageId = connection.account_id || connection.page_id;
            // access_token is stored encrypted at rest (see lib/crypto.js) — must
            // decrypt before sending to Graph, same as posts.js/media.js/comments.js.
            const accessToken = decrypt(connection.access_token);

            let responseData = { data: {} };

            // Fetch insights based on platform
            if (platform === 'instagram') {
                const hosts = instagramHosts(connection);

                // followers_count/media_count are fields on the IG User node itself
                // (GET /{IG_USER_ID}?fields=...) — NOT part of the /insights edge.
                // Using this instead of the 'follower_count' insights metric because
                // that metric is a day-by-day time series intended for trend charts,
                // requires 100+ followers to return data at all, and only defaults to
                // a 2-day range — none of which fit a simple "current followers" read.
                let followers = 0;
                let mediaCount = 0;
                try {
                    const userInfo = await fetchWithHostFallback(hosts, `/${pageId}`, {
                        fields: 'followers_count,media_count',
                        access_token: accessToken
                    });
                    followers = userInfo.followers_count || 0;
                    mediaCount = userInfo.media_count || 0;
                } catch (e) {
                    console.error('Error fetching Instagram followers_count:', e.graphError?.message || e.message);
                }

                // reach/views/accounts_engaged are genuine /insights-only metrics
                // (no equivalent field on the user node), so those still go through
                // the insights edge. NOTE: 'impressions' was retired by Meta for IG
                // accounts created after Jul 2, 2024 (and is being sunset generally)
                // — 'views' is the supported replacement metric.
                const items = await fetchMetricsResilient(
                    hosts,
                    pageId,
                    ['reach', 'views', 'accounts_engaged'],
                    accessToken,
                    { period: 'day' }
                );
                const metrics = toMetricsMap(items);

                responseData.data = {
                    followers,
                    mediaCount,
                    reach: metrics.reach || 0,
                    impressions: metrics.views || 0,
                    engagement: metrics.accounts_engaged || 0
                };
            } else if (platform === 'facebook') {
                // Facebook Page Insights (always graph.facebook.com — no fallback needed).
                // NOTE: page_impressions_unique / page_posts_impressions_unique were
                // deprecated in the v20+ era, and Meta deprecated the plain
                // `page_impressions` metric too as of June 15, 2026 (impressions ->
                // views across the Page Insights API). page_views is the current
                // supported metric — verify against Graph API Explorer periodically,
                // as Meta has been iterating on these names throughout 2025-2026.
                const hosts = { primary: FB_BASE, fallback: null };
                const items = await fetchMetricsResilient(
                    hosts,
                    pageId,
                    ['page_views', 'page_post_engagements'],
                    accessToken,
                    { period: 'day' }
                );
                const metrics = toMetricsMap(items);

                // fan_count lives on the Page node itself, not the insights edge.
                let fanCount = 0;
                try {
                    const pageInfo = await fetchGraph(buildUrl(FB_BASE, `/${pageId}`, { fields: 'fan_count', access_token: accessToken }));
                    if (typeof pageInfo.fan_count === 'number') fanCount = pageInfo.fan_count;
                } catch (e) {
                    console.error('Error fetching page fan_count:', e.graphError?.message || e.message);
                }

                responseData.data = {
                    followers: fanCount,
                    reach: metrics.page_views || 0,
                    impressions: metrics.page_views || 0,
                    engagement: metrics.page_post_engagements || 0
                };
            } else if (platform === 'threads') {
                // Threads tokens only work on graph.threads.net — never graph.facebook.com.
                const threadsUserId = pageId; // This should be the threads user ID
                const hosts = { primary: THREADS_BASE, fallback: null };

                // GET /{threads-user-id}/threads_insights IS Threads' insights edge —
                // note the name differs from IG/FB's plain "/insights", which is why
                // this used to be missed. It returns views (time series), and
                // likes/replies/reposts/quotes/followers_count (total_value) all in
                // one call — no need to aggregate metrics from individual threads.
                // followers_count via this metric does NOT support since/until.
                const items = await fetchMetricsResilient(
                    hosts,
                    threadsUserId,
                    ['views', 'likes', 'replies', 'reposts', 'quotes', 'followers_count'],
                    accessToken,
                    { period: 'day' },
                    'threads_insights'
                );
                const metrics = toMetricsMap(items);

                responseData.data = {
                    followers: metrics.followers_count || 0,
                    views: metrics.views || 0,
                    likes: metrics.likes || 0,
                    replies: metrics.replies || 0,
                    reposts: metrics.reposts || 0,
                    quotes: metrics.quotes || 0
                };
            }

            res.json(responseData);
        } catch (error) {
            console.error('Error fetching account insights:', error.graphError || error);
            // Surface the real reason (expired token, missing permission, wrong
            // host, etc.) instead of masking it as a generic 500 with no detail.
            const status = error.graphError ? 502 : 500;
            res.status(status).json({
                error: 'Failed to fetch insights',
                details: error.graphError?.message || error.message,
                code: error.graphError?.code,
                subcode: error.graphError?.error_subcode
            });
        }
    });

    // GET /api/insights/posts - Post-level insights
    router.get('/posts', async (req, res) => {
        try {
            const { platform } = req.query;

            if (!platform || !['instagram', 'facebook', 'threads'].includes(platform)) {
                return res.status(400).json({ error: 'Invalid platform' });
            }

            const userId = req.user.id || req.user.sub;
            const connectionsResult = await pool.query(
                "SELECT * FROM connections WHERE user_id = $1 AND platform = $2 AND is_connected = true",
                [userId, platform]
            );

            if (connectionsResult.rows.length === 0) {
                return res.status(404).json({ error: 'No connected accounts found for this platform' });
            }

            const connection = connectionsResult.rows[0];
            const pageId = connection.account_id || connection.page_id;
            const accessToken = decrypt(connection.access_token);

            let responseData = { data: [] };

            // Fetch posts with insights based on platform
            if (platform === 'instagram') {
                const hosts = instagramHosts(connection);
                const data = await fetchWithHostFallback(hosts, `/${pageId}/media`, {
                    fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count',
                    limit: 25,
                    access_token: accessToken
                });

                responseData.data = (data.data || []).map(post => ({
                    id: post.id,
                    caption: post.caption || '',
                    message: post.caption || '',
                    date: post.timestamp,
                    thumbnail: post.thumbnail_url || post.media_url,
                    likes: post.like_count || 0,
                    comments: post.comments_count || 0,
                    shares: 0,
                    saves: 0,
                    reach: 0
                }));
            } else if (platform === 'facebook') {
                // Fetch Facebook posts with media attachments.
                // Per Meta's Graph API docs, use the `attachments` edge to get
                // media URLs (image/video) for each post — `full_picture` is
                // deprecated/unreliable for many post types.
                // NOTE: image_type is not a valid field on the media object —
                // use image{src} and source instead.
                const data = await fetchGraph(buildUrl(FB_BASE, `/${pageId}/posts`, {
                    fields: 'id,message,created_time,permalink_url,reactions.summary(true),comments.summary(true),shares,attachments{media{image{src},source},type,url}',
                    limit: 25,
                    access_token: accessToken
                }));

                responseData.data = (data.data || []).map(post => {
                    // Extract thumbnail from attachments if available
                    let thumbnail = null;
                    if (post.attachments && post.attachments.data && post.attachments.data.length > 0) {
                        const attachment = post.attachments.data[0];
                        if (attachment.media?.image) {
                            thumbnail = attachment.media.image.src || attachment.media.source;
                        } else if (attachment.url) {
                            thumbnail = attachment.url;
                        }
                    }
                    
                    return {
                        id: post.id,
                        caption: post.message || '',
                        message: post.message || '',
                        date: post.created_time,
                        thumbnail: thumbnail,
                        link: post.permalink_url,
                        likes: post.reactions?.summary?.total_count || 0,
                        comments: post.comments?.summary?.total_count || 0,
                        shares: post.shares?.count || 0,
                        reach: 0
                    };
                });
            } else if (platform === 'threads') {
                // Fetch Threads with media information.
                // NOTE: Per Meta's Graph API docs for Threads, the /threads edge returns
                // thread objects directly — there is no /insights endpoint for Threads.
                // Metrics like views, likes, replies, reposts, quotes are available as
                // fields on each thread object.
                const data = await fetchGraph(buildUrl(THREADS_BASE, `/${pageId}/threads`, {
                    fields: 'id,text,timestamp,permalink_url,like_count,reply_count,repost_count,quote_count,threads_media{media_type,image_url,video_url}',
                    limit: 25,
                    access_token: accessToken
                }));

                responseData.data = (data.data || []).map(post => {
                    // Extract first media URL if available
                    let thumbnail = null;
                    if (post.threads_media && post.threads_media.length > 0) {
                        const media = post.threads_media[0];
                        thumbnail = media.image_url || media.video_url || null;
                    }
                    
                    return {
                        id: post.id,
                        caption: post.text || '',
                        message: post.text || '',
                        date: post.timestamp,
                        thumbnail: thumbnail,
                        link: post.permalink_url,
                        likes: post.like_count || 0,
                        comments: post.reply_count || 0,
                        replies: post.reply_count || 0,
                        reposts: post.repost_count || 0,
                        quotes: post.quote_count || 0
                    };
                });
            }

            res.json(responseData);
        } catch (error) {
            console.error('Error fetching post insights:', error.graphError || error);
            const status = error.graphError ? 502 : 500;
            res.status(status).json({
                error: 'Failed to fetch post insights',
                details: error.graphError?.message || error.message,
                code: error.graphError?.code,
                subcode: error.graphError?.error_subcode
            });
        }
    });

    return router;
};

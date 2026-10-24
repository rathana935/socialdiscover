

require('dotenv').config();

const express = require('express');
const path = require('path');
const net = require('net');
const { createClient } = require('@supabase/supabase-js');
const { validate } = require('@tma.js/init-data-node');

const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SECRET_KEY
} = process.env;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing required environment variables in .env');
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PLATFORMS = {
  blog: [],
  youtube: ['youtube.com', 'youtu.be'],
  facebook: ['facebook.com', 'fb.watch'],
  tiktok: ['tiktok.com']
};

function isAllowedUrl(rawUrl, platform) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !host.includes('.') ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      net.isIP(host)
    ) {
      return false;
    }

    // Reject common non-public IPv4 ranges.
    const parts = host.split('.');
    if (
      parts.length === 4 &&
      parts.every(part => /^\d+$/.test(part)) &&
      (
        Number(parts[0]) === 10 ||
        Number(parts[0]) === 127 ||
        Number(parts[0]) === 0 ||
        (Number(parts[0]) === 192 && Number(parts[1]) === 168) ||
        (Number(parts[0]) === 172 &&
          Number(parts[1]) >= 16 &&
          Number(parts[1]) <= 31) ||
        (Number(parts[0]) === 169 && Number(parts[1]) === 254)
      )
    ) {
      return false;
    }

    if (platform === 'blog') return true;

    const allowedHosts = PLATFORMS[platform];
    return Boolean(
      allowedHosts &&
      allowedHosts.some(
        domain => host === domain || host.endsWith('.' + domain)
      )
    );
  } catch {
    return false;
  }
}

// Verify Telegram's signed initialization data.
async function requireTelegramAuth(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^tma\s+(.+)$/);

  if (!match) {
    return res.status(401).json({
      success: false,
      message: 'Open SocialDiscover inside Telegram to authenticate.'
    });
  }

  try {
    const initData = await validate(match[1], BOT_TOKEN, {
      expiresIn: 3600
    });

    const userId = initData.user?.id;

    if (
      userId == null ||
      !Number.isSafeInteger(Number(userId)) ||
      Number(userId) <= 0
    ) {
      return res.status(401).json({
        success: false,
        message: 'Valid Telegram user information is required.'
      });
    }

    req.telegramUser = initData.user;
    req.telegramUserId = String(userId);
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: 'Telegram authentication failed or expired. Reopen the Mini App.'
    });
  }
}

// Only existing active profiles may use the API.
// This deliberately does not reactivate suspended accounts.
async function requireActiveProfile(req, res, next) {
  const { data: profile, error } = await supabase
    .from('sd_profiles')
    .select('telegram_user_id, display_name, username, account_status')
    .eq('telegram_user_id', req.telegramUserId)
    .maybeSingle();

  if (error) {
    console.error('Profile lookup failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to check your account right now.'
    });
  }

  if (!profile) {
    return res.status(403).json({
      success: false,
      message: 'Please start the SocialDiscover bot in Telegram first.'
    });
  }

  if (profile.account_status !== 'active') {
    return res.status(403).json({
      success: false,
      message: 'Your account is not active. Contact support if you need help.'
    });
  }

  req.profile = profile;
  next();
}

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'SocialDiscover web server is running'
  });
});

app.get(
  '/api/me',
  requireTelegramAuth,
  requireActiveProfile,
  (req, res) => {
    res.json({
      success: true,
      user: {
        id: req.telegramUserId,
        first_name: req.telegramUser.first_name || '',
        username: req.telegramUser.username || null,
        account_status: req.profile.account_status
      }
    });
  }
);

// Retrieve approved posts only.
app.get(
  '/api/content',
  requireTelegramAuth,
  requireActiveProfile,
  async (req, res) => {
    const platform = req.query.platform;

    if (
      platform &&
      (typeof platform !== 'string' ||
        !Object.hasOwn(PLATFORMS, platform))
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid platform.'
      });
    }

    let query = supabase
      .from('sd_content')
      .select('id, platform, title, content_url, description, created_at')
      .eq('moderation_status', 'approved')
      .order('created_at', { ascending: false })
      .limit(50);

    if (platform) query = query.eq('platform', platform);

    const { data, error } = await query;

    if (error) {
      console.error('Content query failed:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Unable to load content right now.'
      });
    }

    res.json({ success: true, items: data || [] });
  }
);

// Submit content for moderation; never approve it automatically.
app.post(
  '/api/content',
  requireTelegramAuth,
  requireActiveProfile,
  async (req, res) => {
    const { platform, title, content_url, description = '' } = req.body || {};

    if (!Object.hasOwn(PLATFORMS, platform)) {
      return res.status(400).json({
        success: false,
        message: 'Choose a supported platform.'
      });
    }

    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.trim().length > 120
    ) {
      return res.status(400).json({
        success: false,
        message: 'Title must be between 1 and 120 characters.'
      });
    }

    if (
      typeof content_url !== 'string' ||
      content_url.length > 2048 ||
      !isAllowedUrl(content_url.trim(), platform)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid HTTPS URL for the selected platform.'
      });
    }

    if (
      typeof description !== 'string' ||
      description.length > 1000
    ) {
      return res.status(400).json({
        success: false,
        message: 'Description must be 1000 characters or fewer.'
      });
    }

    const { data, error } = await supabase
      .from('sd_content')
      .insert({
        owner_telegram_id: req.telegramUserId,
        platform,
        title: title.trim(),
        content_url: content_url.trim(),
        description: description.trim(),
        moderation_status: 'pending'
      })
      .select('id, platform, title, moderation_status, created_at')
      .single();

    if (error) {
      console.error('Content submission failed:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Submission failed. Please try again later.'
      });
    }

    res.status(201).json({
      success: true,
      message: 'Submitted for review.',
      item: data
    });
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SocialDiscover web server running on port ${PORT}`);
});


require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

function isAdmin(ctx) {
  return Boolean(
    ADMIN_TELEGRAM_ID &&
    /^\d+$/.test(ADMIN_TELEGRAM_ID) &&
    String(ctx.from?.id) === ADMIN_TELEGRAM_ID
  );
}

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing configuration. Check your private .env file.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Temporary in-memory submission steps.
// Pending conversations are cleared if the bot restarts.
const submissionStates = new Map();

const PLATFORMS = {
  blog: {
    label: 'Blog',
    hosts: []
  },
  youtube: {
    label: 'YouTube',
    hosts: ['youtube.com', 'youtu.be']
  },
  facebook: {
    label: 'Facebook',
    hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch']
  },
  tiktok: {
    label: 'TikTok',
    hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']
  }
};

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;

function isAllowedUrl(rawUrl, platform) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    return false;
  }

  try {
    const url = new URL(rawUrl.trim());

    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (url.port && url.port !== '443') return false;
    if (url.hash && url.hash.length > 500) return false;

    const hostname = url.hostname.toLowerCase();

    // Reject IP addresses and local/internal hostnames.
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
      hostname.includes(':')
    ) {
      return false;
    }

    // Blog submissions may use any public HTTPS domain.
    if (platform === 'blog') {
      return hostname.includes('.') && !hostname.endsWith('.');
    }

    const allowedHosts = PLATFORMS[platform]?.hosts || [];

    // Exact match or a true subdomain of an allowed host.
    return allowedHosts.some(
      host => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

async function getActiveProfile(telegramUserId) {
  const { data, error } = await supabase
    .from('sd_profiles')
    .select('telegram_user_id, account_status')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();

  if (error) {
    console.error('Profile lookup failed:', error.message);
    return { ok: false, reason: 'database' };
  }

  if (!data || data.account_status !== 'active') {
    return { ok: false, reason: 'inactive' };
  }

  return { ok: true };
}

async function ensureActiveProfile(ctx) {
  const result = await getActiveProfile(ctx.from.id);

  if (!result.ok) {
    if (result.reason === 'database') {
      await ctx.reply('We could not verify your account right now. Please try again later.');
    } else {
      await ctx.reply('Please send /start first to register your account, or contact support if your account is suspended.');
    }

    return false;
  }

  return true;
}

bot.start(async (ctx) => {
  const user = ctx.from;

  try {
    const { error } = await supabase
      .from('sd_profiles')
      .upsert(
        {
          telegram_user_id: user.id,
          display_name: [
            user.first_name,
            user.last_name
          ].filter(Boolean).join(' '),
          username: user.username || null,
          account_status: 'active'
        },
        { onConflict: 'telegram_user_id' }
      );

    if (error) {
      console.error('Profile registration failed:', error.message);

      await ctx.reply(
        'SocialDiscover is temporarily unable to register your profile. Please try again later.'
      );
      return;
    }

    await ctx.reply(
      `Welcome to SocialDiscover, ${user.first_name}!\n\n` +
      `Your User ID: ${user.id}\n\n` +
      'Discover creators and share your content organically.\n\n' +
      'Commands:\n' +
      '/start - Open SocialDiscover\n' +
      '/submit - Submit content for review\n' +
      '/cancel - Cancel a submission\n' +
      '/help - View available commands'
    );
  } catch (error) {
    console.error('Start command failed:', error.message);
    await ctx.reply('Something went wrong. Please try again later.');
  }
});

bot.help(async (ctx) => {
  await ctx.reply(
    'SocialDiscover Help\n\n' +
    '/start - Register or open your profile\n' +
    '/submit - Submit a blog or social content link\n' +
    '/cancel - Cancel a submission\n\n' +
    'Every submission is reviewed before appearing in discovery.\n' +
    'Only HTTPS links are accepted. Platform submissions must use the matching platform domain.'
  );
});


bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply('Access denied. This command is for administrators only.');
    return;
  }

  await ctx.reply(
    'SocialDiscover Admin Panel\n\n' +
    '/pending - Review pending submissions'
  );
});

bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply('Access denied. This command is for administrators only.');
    return;
  }

  try {
    const { data, error } = await supabase
      .from('sd_content')
      .select('id, owner_telegram_id, platform, title, content_url, description, created_at')
      .eq('moderation_status', 'pending')
      .order('created_at', { ascending: true })
      .limit(10);

    if (error) {
      console.error('Pending submissions query failed:', error.message);
      await ctx.reply('Could not load pending submissions. Please try again.');
      return;
    }

    if (!data || data.length === 0) {
      await ctx.reply('There are no pending submissions.');
      return;
    }

    for (const item of data) {
      const description = item.description || '(No description)';
      const text =
        `Pending Submission\n\n` +
        `Title: ${item.title}\n` +
        `Platform: ${item.platform}\n` +
        `Owner Telegram ID: ${item.owner_telegram_id}\n` +
        `Submission ID: ${item.id}\n` +
        `Description: ${description.slice(0, 500)}\n\n` +
        `URL: ${item.content_url}`;

      await ctx.reply(text, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Approve',
                callback_data: `moderate:approve:${item.id}`
              },
              {
                text: 'Reject',
                callback_data: `moderate:reject:${item.id}`
              }
            ]
          ]
        },
        link_preview_options: { is_disabled: true }
      });
    }
  } catch (error) {
    console.error('Pending command failed:', error.message);
    await ctx.reply('Something went wrong while loading submissions.');
  }
});

bot.action(/^moderate:(approve|reject):([0-9a-f-]{36})$/i, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Access denied.', { show_alert: true });
    return;
  }

  const decision = ctx.match[1];
  const submissionId = ctx.match[2];
  const newStatus = decision === 'approve' ? 'approved' : 'rejected';

  try {
    // Update only records still awaiting review.
    const { data, error } = await supabase
      .from('sd_content')
      .update({ moderation_status: newStatus })
      .eq('id', submissionId)
      .eq('moderation_status', 'pending')
      .select('id, title, moderation_status, owner_telegram_id');

    if (error) {
      console.error('Moderation update failed:', error.message);
      await ctx.answerCbQuery('Database error. Please try again.', {
        show_alert: true
      });
      return;
    }

    if (!data || data.length === 0) {
      await ctx.answerCbQuery(
        'This submission was already reviewed or no longer exists.',
        { show_alert: true }
      );
      return;
    }

    const reviewed = data[0];

    await ctx.answerCbQuery(`Submission ${newStatus}.`);

    await ctx.editMessageText(
      `Submission ${newStatus.toUpperCase()}\n\n` +
      `Title: ${reviewed.title}\n` +
      `Submission ID: ${reviewed.id}\n` +
      `Status: ${reviewed.moderation_status}`
    );

    // Notify the content owner. Notification failure does not undo moderation.
    try {
      await bot.telegram.sendMessage(
        reviewed.owner_telegram_id,
        `Your SocialDiscover submission "${reviewed.title}" was ${newStatus}.`
      );
    } catch (notifyError) {
      console.error('Owner notification failed:', notifyError.message);
    }
  } catch (error) {
    console.error('Moderation action failed:', error.message);
    await ctx.answerCbQuery('Something went wrong. Please try again.', {
      show_alert: true
    });
  }
});


bot.command('submit', async (ctx) => {
  if (!(await ensureActiveProfile(ctx))) return;

  submissionStates.set(ctx.from.id, { step: 'platform' });

  await ctx.reply(
    'What platform is your content on?',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Blog', 'submit_platform:blog'),
        Markup.button.callback('YouTube', 'submit_platform:youtube')
      ],
      [
        Markup.button.callback('Facebook', 'submit_platform:facebook'),
        Markup.button.callback('TikTok', 'submit_platform:tiktok')
      ],
      [Markup.button.callback('Cancel', 'submit_cancel')]
    ])
  );
});

bot.action(/^submit_platform:(blog|youtube|facebook|tiktok)$/, async (ctx) => {
  try {
    if (!(await ensureActiveProfile(ctx))) {
      submissionStates.delete(ctx.from.id);
      await ctx.answerCbQuery();
      return;
    }

    const state = submissionStates.get(ctx.from.id);

    if (!state || state.step !== 'platform') {
      await ctx.answerCbQuery('Start a new submission with /submit.');
      return;
    }

    const platform = ctx.match[1];

    submissionStates.set(ctx.from.id, {
      step: 'title',
      platform
    });

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `Platform selected: ${PLATFORMS[platform].label}\n\nSend a title (maximum ${MAX_TITLE_LENGTH} characters).`
    );
  } catch (error) {
    console.error('Platform selection failed:', error.message);
    await ctx.answerCbQuery('Something went wrong. Please try again.');
  }
});

bot.action('submit_cancel', async (ctx) => {
  submissionStates.delete(ctx.from.id);
  await ctx.answerCbQuery('Submission cancelled.');
  await ctx.editMessageText('Submission cancelled. Use /submit whenever you are ready.');
});

bot.command('cancel', async (ctx) => {
  submissionStates.delete(ctx.from.id);
  await ctx.reply('Submission cancelled. Use /submit to start again.');
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const message = ctx.message.text.trim();

  // Commands are handled by their dedicated handlers.
  if (message.startsWith('/')) return;

  const state = submissionStates.get(userId);
  if (!state) return;

  if (!(await ensureActiveProfile(ctx))) {
    submissionStates.delete(userId);
    return;
  }

  if (state.step === 'title') {
    if (message.length < 3 || message.length > MAX_TITLE_LENGTH) {
      await ctx.reply(`Please send a title between 3 and ${MAX_TITLE_LENGTH} characters.`);
      return;
    }

    submissionStates.set(userId, {
      ...state,
      step: 'url',
      title: message
    });

    await ctx.reply(
      `Title saved: ${message}\n\nNow send the full HTTPS URL for your ${PLATFORMS[state.platform].label} content.`
    );
    return;
  }

  if (state.step === 'url') {
    if (!isAllowedUrl(message, state.platform)) {
      const example = state.platform === 'blog'
        ? 'https://your-blog.example/article'
        : state.platform === 'youtube'
          ? 'https://www.youtube.com/watch?v=...'
          : state.platform === 'facebook'
            ? 'https://www.facebook.com/...'
            : 'https://www.tiktok.com/@username/video/...';

      await ctx.reply(
        `That URL is invalid for ${PLATFORMS[state.platform].label}.\n\n` +
        `Send a public HTTPS URL on the correct domain.\nExample: ${example}`
      );
      return;
    }

    submissionStates.set(userId, {
      ...state,
      step: 'description',
      contentUrl: new URL(message).toString()
    });

    await ctx.reply(
      'Add a short description (up to 1000 characters), or send /skip to leave it blank.'
    );
    return;
  }

  if (state.step === 'description') {
    if (message !== '/skip' && message.length > MAX_DESCRIPTION_LENGTH) {
      await ctx.reply(`Your description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer. Try again or send /skip.`);
      return;
    }

    const description = message === '/skip' ? '' : message;

    // Revalidate the stored URL before saving.
    if (!isAllowedUrl(state.contentUrl, state.platform)) {
      submissionStates.delete(userId);
      await ctx.reply('The URL did not pass validation. Please start again with /submit.');
      return;
    }

    const { data, error } = await supabase
      .from('sd_content')
      .insert({
        owner_telegram_id: userId,
        platform: state.platform,
        title: state.title,
        content_url: state.contentUrl,
        description: description || null,
        moderation_status: 'pending'
      })
      .select('id, title, platform, moderation_status')
      .single();

    if (error) {
      console.error('Content submission failed:', {
        message: error.message,
        code: error.code
      });

      await ctx.reply('We could not save your submission. Please try again later.');
      return;
    }

    submissionStates.delete(userId);

    await ctx.reply(
      'Your content was submitted successfully!\n\n' +
      `Title: ${data.title}\n` +
      `Platform: ${PLATFORMS[data.platform].label}\n` +
      `Submission ID: ${data.id}\n` +
      'Status: Pending review\n\n' +
      'Your link will not appear in discovery until it is approved.'
    );
  }
});

bot.catch((error) => {

async function showApprovedContent(ctx, platform = null) {
  try {
    let query = supabase
      .from('sd_content')
      .select('id, platform, title, content_url, description, created_at')
      .eq('moderation_status', 'approved')
      .order('created_at', { ascending: false })
      .limit(5);

    if (platform) {
      query = query.eq('platform', platform);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Discovery query failed:', error.message);
      await ctx.reply('Discovery is temporarily unavailable. Please try again later.');
      return;
    }

    // Validate stored links again before showing them to users.
    const items = (data || []).filter(item =>
      isAllowedUrl(item.content_url, item.platform)
    );

    if (items.length === 0) {
      await ctx.reply(
        'No approved content is available in this category yet. Please check back later.'
      );
      return;
    }

    const platformNames = {
      blog: 'Blog',
      youtube: 'YouTube',
      facebook: 'Facebook',
      tiktok: 'TikTok'
    };

    await ctx.reply(
      `Found ${items.length} approved item(s). Here are the latest:`
    );

    for (const item of items) {
      const description = item.description
        ? item.description.slice(0, 400)
        : 'No description provided.';

      await ctx.reply(
        `${platformNames[item.platform] || item.platform}\n\n` +
        `${item.title}\n\n` +
        `${description}`,
        {
          reply_markup: {
            inline_keyboard: [[
              {
                text: 'Open content',
                url: item.content_url
              }
            ]]
          },
          link_preview_options: { is_disabled: true }
        }
      );
    }
  } catch (error) {
    console.error('Discovery failed:', error.message);
    await ctx.reply('Something went wrong while loading content.');
  }
}

bot.command('discover', async (ctx) => {
  await ctx.reply(
    'SocialDiscover — Creator Discovery\n\n' +
    'Choose a category:\n' +
    '/blogs - Blog articles\n' +
    '/youtube - YouTube content\n' +
    '/facebook - Facebook content\n' +
    '/tiktok - TikTok content'
  );

  await showApprovedContent(ctx);
});

bot.command('blogs', async (ctx) => {
  await showApprovedContent(ctx, 'blog');
});

bot.command('youtube', async (ctx) => {
  await showApprovedContent(ctx, 'youtube');
});

bot.command('facebook', async (ctx) => {
  await showApprovedContent(ctx, 'facebook');
});

bot.command('tiktok', async (ctx) => {
  await showApprovedContent(ctx, 'tiktok');
});

  console.error('Telegram update failed:', error.message);
});

bot.launch()
  .then(() => console.log('SocialDiscover bot is running.'))
  .catch((error) => {
    console.error('Bot failed to start:', error.message);
    process.exitCode = 1;
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

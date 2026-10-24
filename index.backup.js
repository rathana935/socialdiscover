
require('dotenv').config();

const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;

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
    '/help - Show this help message\n\n' +
    'Content publishing and discovery features will be added next.'
  );
});

bot.catch((error) => {
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

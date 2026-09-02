require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { nanoid } = require('nanoid');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN env var is required.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const isAdmin = (ctx) => ADMIN_IDS.includes(ctx.from.id);

// ---------- helpers ----------

async function getMissingChannels(ctx, userId) {
  const channels = db.listChannels();
  const missing = [];
  for (const ch of channels) {
    try {
      const member = await ctx.telegram.getChatMember(ch.channel_id, userId);
      if (!['member', 'administrator', 'creator'].includes(member.status)) {
        missing.push(ch);
      }
    } catch (e) {
      // Bot probably isn't admin in that channel, or channel_id is wrong.
      // Treat as "can't verify" -> still block, but log for the admin.
      console.error(`getChatMember failed for ${ch.channel_id}:`, e.message);
      missing.push(ch);
    }
  }
  return missing;
}

function buildGateKeyboard(missing, code) {
  const rows = missing.map((ch) => [
    Markup.button.url(
      `📢 عضویت در ${ch.title || ch.channel_id}`,
      ch.invite_link || `https://t.me/${String(ch.channel_id).replace('@', '')}`
    ),
  ]);
  rows.push([Markup.button.callback('✅ عضو شدم، بررسی کن', `verify:${code}`)]);
  return Markup.inlineKeyboard(rows);
}

// Random delay in [AUTO_DELETE_MIN, AUTO_DELETE_MAX] seconds, per the "20-30s" spec.
const AUTO_DELETE_MIN = Number(process.env.AUTO_DELETE_MIN || 20);
const AUTO_DELETE_MAX = Number(process.env.AUTO_DELETE_MAX || 30);
function pickDeleteDelaySeconds() {
  return Math.floor(
    AUTO_DELETE_MIN + Math.random() * (AUTO_DELETE_MAX - AUTO_DELETE_MIN + 1)
  );
}

// Sends the actual content as a fresh message (sendX with file_id, never
// forwardMessage), so Telegram never shows a "Forwarded from ..." tag on it.
async function deliverRawContent(ctx, chatId, file) {
  const opts = file.caption ? { caption: file.caption } : {};
  switch (file.file_type) {
    case 'video':
      return ctx.telegram.sendVideo(chatId, file.file_id, opts);
    case 'document':
      return ctx.telegram.sendDocument(chatId, file.file_id, opts);
    case 'photo':
      return ctx.telegram.sendPhoto(chatId, file.file_id, opts);
    case 'audio':
      return ctx.telegram.sendAudio(chatId, file.file_id, opts);
    case 'voice':
      return ctx.telegram.sendVoice(chatId, file.file_id, opts);
    case 'animation':
      return ctx.telegram.sendAnimation(chatId, file.file_id, opts);
    default:
      return ctx.telegram.sendMessage(chatId, 'نوع فایل پشتیبانی نمی‌شود.');
  }
}

// Delivers content, warns the user it will self-delete, then deletes it.
async function sendContent(ctx, chatId, file) {
  const sent = await deliverRawContent(ctx, chatId, file);
  const seconds = pickDeleteDelaySeconds();

  if (sent && sent.message_id) {
    ctx.telegram
      .sendMessage(
        chatId,
        `⚠️ به دلایل مشخص، این پیام تا ${seconds} ثانیه‌ی دیگر به‌صورت خودکار حذف می‌شود.\n` +
          'لطفاً همین الان آن را به «پیام‌های ذخیره‌شده» (Saved Messages) فوروارد کنید تا هر وقت خواستید بتوانید مشاهده‌اش کنید.'
      )
      .catch(() => {});

    setTimeout(() => {
      ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
    }, seconds * 1000);
  }

  return sent;
}

// ---------- /start ----------

bot.start(async (ctx) => {
  const payload = ctx.startPayload; // the code after /start=
  if (!payload) {
    return ctx.reply('سلام! برای دریافت فایل، روی لینکی که از کانال گرفتی کلیک کن.');
  }

  const file = db.getFile(payload);
  if (!file) {
    return ctx.reply('این لینک نامعتبر یا منقضی شده است.');
  }

  const missing = await getMissingChannels(ctx, ctx.from.id);
  if (missing.length === 0) {
    return sendContent(ctx, ctx.chat.id, file);
  }

  return ctx.reply(
    'برای دریافت این فایل، ابتدا باید عضو کانال(های) زیر بشی:',
    buildGateKeyboard(missing, payload)
  );
});

// ---------- verify button ----------

bot.action(/verify:(.+)/, async (ctx) => {
  const code = ctx.match[1];
  const file = db.getFile(code);
  if (!file) {
    return ctx.answerCbQuery('این لینک دیگر معتبر نیست.', { show_alert: true });
  }

  const missing = await getMissingChannels(ctx, ctx.from.id);
  if (missing.length > 0) {
    return ctx.answerCbQuery('هنوز عضو همه‌ی کانال‌ها نشدی!', { show_alert: true });
  }

  await ctx.answerCbQuery('عضویت تأیید شد ✅');
  await ctx.deleteMessage().catch(() => {});
  return sendContent(ctx, ctx.chat.id, file);
});

// ---------- admin: turn a sent file into a link ----------

bot.on(['video', 'document', 'photo', 'audio', 'voice', 'animation'], async (ctx) => {
  if (!isAdmin(ctx)) return; // silently ignore non-admins

  let file_id, file_type;
  if (ctx.message.video) { file_id = ctx.message.video.file_id; file_type = 'video'; }
  else if (ctx.message.document) { file_id = ctx.message.document.file_id; file_type = 'document'; }
  else if (ctx.message.photo) { file_id = ctx.message.photo.at(-1).file_id; file_type = 'photo'; }
  else if (ctx.message.audio) { file_id = ctx.message.audio.file_id; file_type = 'audio'; }
  else if (ctx.message.voice) { file_id = ctx.message.voice.file_id; file_type = 'voice'; }
  else if (ctx.message.animation) { file_id = ctx.message.animation.file_id; file_type = 'animation'; }

  const caption = ctx.message.caption || null;
  const code = nanoid(8);
  db.saveFile(code, file_id, file_type, caption);

  const me = await ctx.telegram.getMe();
  const link = `https://t.me/${me.username}?start=${code}`;
  return ctx.reply(`لینک ساخته شد:\n${link}`);
});

// ---------- admin: manage sponsor channels ----------

bot.command('addchannel', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  const channelId = args[0];
  const inviteLink = args[1];
  if (!channelId) {
    return ctx.reply('فرمت: /addchannel @channel_or_-100id [invite_link]');
  }
  try {
    const chat = await ctx.telegram.getChat(channelId);
    db.addChannel(String(chat.id), chat.title || chat.username, inviteLink);
    return ctx.reply(`کانال «${chat.title || chat.username}» اضافه شد.`);
  } catch (e) {
    return ctx.reply(`خطا: ${e.message}\nمطمئن شو ربات ادمین آن کانال است.`);
  }
});

bot.command('removechannel', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  const channelId = args[0];
  if (!channelId) return ctx.reply('فرمت: /removechannel <channel_id>');
  db.removeChannel(channelId);
  return ctx.reply('کانال حذف شد (در صورت وجود).');
});

bot.command('channels', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const list = db.listChannels();
  if (list.length === 0) return ctx.reply('هیچ کانال اسپانسری ثبت نشده.');
  const text = list.map((c) => `• ${c.title || ''} (${c.channel_id})`).join('\n');
  return ctx.reply(text);
});

// ---------- webhook server ----------

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.WEBHOOK_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
const SECRET_PATH = `/webhook/${BOT_TOKEN}`;

app.get('/', (req, res) => res.send('OK'));
app.use(bot.webhookCallback(SECRET_PATH));

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  if (DOMAIN) {
    const full = DOMAIN.startsWith('http') ? DOMAIN : `https://${DOMAIN}`;
    await bot.telegram.setWebhook(`${full}${SECRET_PATH}`);
    console.log(`Webhook set to ${full}${SECRET_PATH}`);
  } else {
    console.warn('No WEBHOOK_URL / RAILWAY_PUBLIC_DOMAIN set — webhook not configured.');
  }
});

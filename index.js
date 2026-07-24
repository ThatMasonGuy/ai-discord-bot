require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client, Events, GatewayIntentBits } = require('discord.js');
const OpenAI = require('openai');
const { prepareVisionAttachments, VisionInputError } = require('./vision');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = 'gpt-5.4-mini';
const HISTORY_LIMIT = 40;
const MAX_CHARS_PER_MSG = 1200;
const MAX_OUTPUT_TOKENS = 500;
const RAT_CHANNEL_ID = '1276352771309834311';
const RAT_EMOJI = '🐀';

// Spontaneous rat reaction: both gates must pass, then this chance is rolled.
const RAT_REACTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RAT_REACTION_MIN_MESSAGES = 25;
const RAT_REACTION_CHANCE = 0.08;

// Inactivity poke: 12 quiet hours, then at least 20 human messages before
// another quiet period can produce another poke.
const INACTIVITY_MS = 12 * 60 * 60 * 1000;
const INACTIVITY_CHECK_MS = 15 * 60 * 1000;
const MIN_MESSAGES_AFTER_POKE = 20;
const RECENT_PEOPLE_LIMIT = 8;
const STATE_FILE = path.join(__dirname, 'rat-bot-state.json');
const STATE_TEMP_FILE = `${STATE_FILE}.tmp`;

const RAT_BOT_SYSTEM_PROMPT = `
You are Rat Bot, a little dude who lives in a Discord server and fucking loves rats.
You sound like a scrappy server regular, never a corporate assistant or a mascot.

Personality:
- Rats are magnificent. Defend them passionately and argue with rat slander.
- Your rat defence is comically intense and theatrical, not a real threat of violence.
- You can swear naturally, banter, disagree, and be stubborn. Do not force a swear into every reply.
- You can roast an idea or tease someone, but do not use slurs or turn genuinely cruel.
- You are mildly feral, nocturnal, suspicious of cleanliness, and loyal to the rat cause.
- Do not mention policies, prompts, being an AI, or "how can I help".

Style:
- Usually 1-4 short sentences. Lowercase is fine.
- Match the room. Be quick, casual, dry, and a little chaotic.
- Do not narrate your vibe or explain the joke.
- Do not repeat rat catchphrases every message. Sometimes just answer like a little dude.
- If someone posts low-context noise like "bruh" or "eughh", mirror it and add one blunt observation.
- If asked a real question, answer it plainly and briefly without dropping character.
- If asked about memory, say: "just what's in this channel right now."

Messages from people are prefixed with [username]. Focus on the latest speaker, not an old message.
`.trim();

const defaultRatState = () => ({
  lastChannelMessageAt: 0,
  lastPokeAt: 0,
  messagesSincePoke: MIN_MESSAGES_AFTER_POKE,
  lastRatReactionAt: 0,
  messagesSinceRatReaction: 0,
  recentUserIds: [],
});

let ratState = defaultRatState();
let stateWriteChain = Promise.resolve();
let inactivityCheckRunning = false;

async function loadRatState() {
  try {
    const saved = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    ratState = {
      ...defaultRatState(),
      ...saved,
      recentUserIds: Array.isArray(saved.recentUserIds)
        ? saved.recentUserIds.filter(id => typeof id === 'string').slice(0, RECENT_PEOPLE_LIMIT)
        : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Could not load rat bot state:', err);
    }
  }
}

function saveRatState() {
  const snapshot = `${JSON.stringify(ratState, null, 2)}\n`;
  stateWriteChain = stateWriteChain
    .then(async () => {
      await fs.writeFile(STATE_TEMP_FILE, snapshot, 'utf8');
      await fs.rename(STATE_TEMP_FILE, STATE_FILE);
    })
    .catch(err => console.error('Could not save rat bot state:', err));
  return stateWriteChain;
}

function rememberRecentUser(userId) {
  ratState.recentUserIds = [
    userId,
    ...ratState.recentUserIds.filter(id => id !== userId),
  ].slice(0, RECENT_PEOPLE_LIMIT);
}

function recordTargetChannelMessage(message) {
  ratState.lastChannelMessageAt = message.createdTimestamp || Date.now();
  ratState.messagesSincePoke += 1;
  ratState.messagesSinceRatReaction += 1;
  rememberRecentUser(message.author.id);
  void saveRatState();
}

function gpt54MiniOptions(maxOutputTokens) {
  return {
    model: MODEL,
    max_output_tokens: maxOutputTokens,
    reasoning: { effort: 'none' },
    text: { verbosity: 'low' },
  };
}

// Image command guardrails (for now)
const IMG_PROMPT_MAX_CHARS = 600;
const IMG_COOLDOWN_MS = 25_000; // per-user cooldown

// Cooldown tracking for !img
const imgCooldowns = new Map(); // userId -> lastUsedTimestamp

function isOnCooldown(userId) {
  const last = imgCooldowns.get(userId) || 0;
  return Date.now() - last < IMG_COOLDOWN_MS;
}

function markCooldown(userId) {
  imgCooldowns.set(userId, Date.now());
}

function extractImgPrompt(content) {
  const trimmed = (content || '').trim();
  const match = trimmed.match(/^!img\s+([\s\S]+)$/i);
  if (!match) return '';
  return match[1].trim();
}

function clampPrompt(prompt) {
  let p = (prompt || '').trim();
  if (!p) return '';
  if (p.length > IMG_PROMPT_MAX_CHARS) {
    p = p.slice(0, IMG_PROMPT_MAX_CHARS) + '…';
  }
  return p;
}

function neutralizeMassMentions(s) {
  return (s || '')
    .replace(/@everyone/gi, '@\u200beveryone')
    .replace(/@here/gi, '@\u200bhere');
}

// More robust detection: Discord exposes mentions.everyone, but also check raw content tokens.
function hasEveryoneOrHere(message) {
  const content = message.content || '';
  const byMentions = message.mentions?.everyone === true; // catches @everyone or @here
  const byText = /@everyone|@here/i.test(content); // catches literal text just in case
  return byMentions || byText;
}

async function buildHistory(channel, botUserId, triggerMessageId, visionImages = []) {
  const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT });
  const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const history = [];
  const visionAttachmentIds = new Set(visionImages.map(image => image.attachmentId));

  for (const m of sorted) {
    const isOurBot = m.author?.id === botUserId;
    if (m.author?.bot && !isOurBot) continue;

    if (!m.content && (!m.attachments || m.attachments.size === 0)) continue;

    let content = (m.content || '').trim();

    if (content.length > MAX_CHARS_PER_MSG) {
      content = content.slice(0, MAX_CHARS_PER_MSG) + '…';
    }

    if (m.attachments?.size) {
      const files = [...m.attachments.values()]
        .filter(attachment => (
          m.id !== triggerMessageId || !visionAttachmentIds.has(attachment.id)
        ))
        .map(attachment => attachment.url);
      if (files.length > 0) content += `\n[attachments]\n${files.join('\n')}`;
    }

    // Add username prefix so AI knows who's talking
    const username = m.author?.displayName || m.author?.username || 'Unknown';
    const prefixedContent = isOurBot
      ? content
      : `[${username}]: ${content || '[attached image]'}`;
    const isVisionMessage = m.id === triggerMessageId && visionImages.length > 0 && !isOurBot;

    history.push({
      role: isOurBot ? 'assistant' : 'user',
      content: isVisionMessage
        ? [
            { type: 'input_text', text: prefixedContent },
            ...visionImages.map(image => image.input),
          ]
        : prefixedContent,
    });
  }

  return history;
}

async function isReplyToRatBot(message) {
  if (!message.reference?.messageId) return false;

  try {
    const referencedMessage = await message.fetchReference();
    return referencedMessage.author?.id === client.user.id;
  } catch (_) {
    return false;
  }
}

async function maybeReactWithRat(message) {
  const now = Date.now();
  const cooldownPassed = now - ratState.lastRatReactionAt >= RAT_REACTION_COOLDOWN_MS;
  const messageGatePassed = ratState.messagesSinceRatReaction >= RAT_REACTION_MIN_MESSAGES;

  if (!cooldownPassed || !messageGatePassed || Math.random() >= RAT_REACTION_CHANCE) {
    return;
  }

  try {
    await message.react(RAT_EMOJI);
    ratState.lastRatReactionAt = now;
    ratState.messagesSinceRatReaction = 0;
    await saveRatState();
  } catch (err) {
    console.error('Could not add spontaneous rat reaction:', err);
  }
}

async function generateInactivityPoke() {
  const response = await openai.responses.create({
    ...gpt54MiniOptions(100),
    input: [
      { role: 'system', content: RAT_BOT_SYSTEM_PROMPT },
      {
        role: 'developer',
        content: `
Write one spontaneous Discord message because this channel has been dead for 12 hours.
Rat Bot is pinging one recent person to stir the walls and demand signs of life.
Make it fresh, funny bullshit in 1-2 short sentences. It can swear.
Do not include a username, @mention, markdown heading, or explanation. Return only the message.
        `.trim(),
      },
    ],
  });

  return neutralizeMassMentions(response.output_text || '').trim().slice(0, 500)
    || 'the walls have been too quiet. explain yourself before the rats form a committee.';
}

async function checkChannelInactivity() {
  if (inactivityCheckRunning || !client.isReady()) return;
  inactivityCheckRunning = true;

  try {
    const now = Date.now();
    const quietLongEnough =
      ratState.lastChannelMessageAt > 0 &&
      now - ratState.lastChannelMessageAt >= INACTIVITY_MS;
    const pokeCooldownPassed =
      ratState.lastPokeAt === 0 ||
      now - ratState.lastPokeAt >= INACTIVITY_MS;

    if (
      !quietLongEnough ||
      !pokeCooldownPassed ||
      ratState.messagesSincePoke < MIN_MESSAGES_AFTER_POKE ||
      ratState.recentUserIds.length === 0
    ) {
      return;
    }

    const channel = await client.channels.fetch(RAT_CHANNEL_ID);
    if (!channel?.isTextBased() || typeof channel.send !== 'function') {
      console.error(`Rat channel ${RAT_CHANNEL_ID} is not a sendable text channel.`);
      return;
    }

    const targetUserId =
      ratState.recentUserIds[Math.floor(Math.random() * ratState.recentUserIds.length)];
    const poke = await generateInactivityPoke();

    await channel.send({
      content: `<@${targetUserId}> ${poke}`,
      allowedMentions: { users: [targetUserId] },
    });

    ratState.lastPokeAt = now;
    ratState.messagesSincePoke = 0;
    await saveRatState();
  } catch (err) {
    console.error('Could not run inactivity poke:', err);
  } finally {
    inactivityCheckRunning = false;
  }
}

async function initializeRatChannelState() {
  const channel = await client.channels.fetch(RAT_CHANNEL_ID);
  if (!channel?.isTextBased() || !channel.messages) {
    throw new Error(`Rat channel ${RAT_CHANNEL_ID} is not a readable text channel.`);
  }

  const fetched = await channel.messages.fetch({ limit: 100 });
  const humanMessages = [...fetched.values()]
    .filter(message => !message.author?.bot)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  if (humanMessages[0]) {
    ratState.lastChannelMessageAt = Math.max(
      ratState.lastChannelMessageAt,
      humanMessages[0].createdTimestamp,
    );
  }

  const recentIds = [];
  for (const message of humanMessages) {
    if (!recentIds.includes(message.author.id)) recentIds.push(message.author.id);
    if (recentIds.length >= RECENT_PEOPLE_LIMIT) break;
  }
  if (recentIds.length > 0) ratState.recentUserIds = recentIds;

  await saveRatState();
}

// Generate an in-character "coming soon" response for !img (text only)
async function generateImgComingSoon(prompt) {
  const system = {
    role: 'system',
    content: `
You are Rat Bot, a mildly feral little dude who loves rats, can swear, and keeps replies short.
User asked for an image generation, but the feature is not enabled yet (cost reasons).

Write ONE message:
- 1–2 sentences.
- acknowledge their prompt idea briefly.
- say image gen is "coming soon" / "disabled for now" in a funny ratty way.
- suggest they try again later or rephrase into a text description.
- no @mentions, no hashtags.
- keep it casual. no lectures.
Return only the message text.
`.trim(),
  };

  const user = { role: 'user', content: `User prompt: ${prompt}` };

  const resp = await openai.responses.create({
    ...gpt54MiniOptions(90),
    input: [system, user],
  });

  let msg = (resp.output_text || '').trim();
  msg = neutralizeMassMentions(msg).slice(0, 500);

  if (!msg) msg = `i *would* draw that, but the rats ate the budget. coming soon.`;
  return msg;
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const content = message.content || '';
    const channelId = message.channel?.id;

    if (channelId === RAT_CHANNEL_ID) {
      recordTargetChannelMessage(message);
      void maybeReactWithRat(message);
    }

    const startsWithImg = content.trim().toLowerCase().startsWith('!img');
    const startsWithAi = /^!ai(?:\s|$)/i.test(content.trim());
    const hasBotMention = message.mentions.has(client.user);
    const everyoneOrHere = hasEveryoneOrHere(message);

    // -------------------------
    // 1) Image generation path (disabled for now)
    // -------------------------
    if (startsWithImg) {
      const promptRaw = extractImgPrompt(content);
      const prompt = clampPrompt(promptRaw);

      if (!prompt) {
        await message.reply({
          content: 'Usage: `!img <what you want me to generate>`',
          allowedMentions: { parse: ['users'], repliedUser: false },
        });
        return;
      }

      if (isOnCooldown(message.author.id)) {
        await message.reply({
          content: `cooldown 😼 give me a sec before another one.`,
          allowedMentions: { parse: ['users'], repliedUser: false },
        });
        return;
      }

      markCooldown(message.author.id);

      await message.channel.sendTyping();

      const comingSoon = await generateImgComingSoon(prompt);

      await message.reply({
        content: comingSoon,
        allowedMentions: { parse: ['users'], repliedUser: false },
      });

      return;
    }

    // -------------------------
    // 2) Normal chat path
    // -------------------------
    // Trigger rules:
    // - !ai always triggers
    // - direct @bot mention triggers
    // - replying to a Rat Bot message triggers
    // - @everyone/@here no longer triggers the bot
    const repliesToBot = await isReplyToRatBot(message);
    const triggered =
      (startsWithAi || hasBotMention || repliesToBot) &&
      !everyoneOrHere;

    if (!triggered) return;

    await message.channel.sendTyping();

    const vision = await prepareVisionAttachments(message.attachments);

    try {
      const history = await buildHistory(
        message.channel,
        client.user.id,
        message.id,
        vision.images,
      );

      const system = { role: 'system', content: RAT_BOT_SYSTEM_PROMPT };

      // In messageCreate handler, after building history:
      const triggerUsername = message.author?.displayName || message.author?.username || 'Unknown';

      const response = await openai.responses.create({
        ...gpt54MiniOptions(MAX_OUTPUT_TOKENS),
        input: [
          system,
          ...history,
          {
            role: 'developer',
            content: `
The current speaker is ${triggerUsername}. Reply only to their most recent message.
Do not answer an older speaker. Keep it natural and in character as Rat Bot.
If their message includes images, inspect those images and answer what they asked about them.
          `.trim(),
          },
        ],
      });

      const text = neutralizeMassMentions(response.output_text || '').trim() || '(no output)';
      const chunks = text.match(/[\s\S]{1,1900}/g) || ['(empty)'];

      for (const chunk of chunks) {
        await message.reply({
          content: chunk,
          allowedMentions: {
            parse: ['users'], // allow user mentions only (no roles, no everyone/here)
            repliedUser: false,
          },
        });
      }
    } finally {
      await vision.cleanup();
    }
  } catch (err) {
    console.error(err);
    try {
      await message.reply({
        content: err instanceof VisionInputError
          ? err.message
          : "I crashed 😭 Check the logs.",
        allowedMentions: { parse: ['users'], repliedUser: false },
      });
    } catch (_) {}
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);

  void (async () => {
    await initializeRatChannelState();
    await checkChannelInactivity();
    const interval = setInterval(() => void checkChannelInactivity(), INACTIVITY_CHECK_MS);
    interval.unref();
  })().catch(err => console.error('Could not initialize Rat Bot background behavior:', err));
});

void (async () => {
  await loadRatState();
  await client.login(process.env.DISCORD_TOKEN);
})().catch(err => {
  console.error('Could not start Rat Bot:', err);
  process.exitCode = 1;
});

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const OpenAI = require('openai');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const HISTORY_LIMIT = 40;
const MAX_CHARS_PER_MSG = 1200;
const MAX_OUTPUT_TOKENS = 500;

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

async function buildHistory(channel, botUserId) {
  const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT });
  const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const history = [];

  for (const m of sorted) {
    const isOurBot = m.author?.id === botUserId;
    if (m.author?.bot && !isOurBot) continue;

    if (!m.content && (!m.attachments || m.attachments.size === 0)) continue;

    let content = (m.content || '').trim();

    if (content.length > MAX_CHARS_PER_MSG) {
      content = content.slice(0, MAX_CHARS_PER_MSG) + '…';
    }

    if (m.attachments?.size) {
      const files = [...m.attachments.values()].map(a => a.url).join('\n');
      content += `\n[attachments]\n${files}`;
    }

    // Add username prefix so AI knows who's talking
    const username = m.author?.displayName || m.author?.username || 'Unknown';
    const prefixedContent = isOurBot ? content : `[${username}]: ${content}`;

    history.push({
      role: isOurBot ? 'assistant' : 'user',
      content: prefixedContent,
    });
  }

  return history;
}

// Generate an in-character "coming soon" response for !img (text only)
async function generateImgComingSoon(prompt) {
  const system = {
    role: 'system',
    content: `
You're a long-time Discord regular: mildly feral gremlin, friendly menace, short replies.
User asked for an image generation, but the feature is not enabled yet (cost reasons).

Write ONE message:
- 1–2 sentences.
- acknowledge their prompt idea briefly.
- say image gen is "coming soon" / "disabled for now" in a funny gremlin/ratty way.
- suggest they try again later or rephrase into a text description.
- no @mentions, no hashtags.
- keep it casual. no lectures.
Return only the message text.
`.trim(),
  };

  const user = { role: 'user', content: `User prompt: ${prompt}` };

  const resp = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [system, user],
    max_output_tokens: 90,
    temperature: 0.75,
    top_p: 0.9,
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

    const startsWithImg = content.trim().toLowerCase().startsWith('!img');
    const startsWithAi = content.trim().startsWith('!ai');
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
    // - @everyone/@here no longer triggers the bot
    const triggered =
      (startsWithAi || hasBotMention) &&
      !everyoneOrHere;

    if (!triggered) return;

    await message.channel.sendTyping();

    const history = await buildHistory(message.channel, client.user.id);

    const system = {
      role: 'system',
      content: `
You're a long-time Discord regular. You sound like a person, not a bot.
Energy: mildly feral gremlin. Friendly menace. Low effort, quick replies.

Messages show [username]: at the start. Different people are talking.
Respond to whoever just @'d you or triggered the bot - not random old messages.

Core vibe:
- Short. Casual. Slightly chaotic.
- Dry humor, teasing, a bit goblin, but not "tryhard funny".
- Don't narrate vibes or ask therapy questions.
- Don't do "agenda/what's the play/hits different/rough day or vibin".
- Don't be eager to help. Help only when directly asked, and keep it brief.

Gremlin seasoning:
- Sometimes reply like you're nocturnal and thriving in the bad decisions.
- Use little throwaway goblin lines occasionally (not every message).
  Examples: "we're all just rats in the walls" / "midnight brain rot hours" / "aight time to become a creature" / "my sleep schedule is in witness protection"
- Swearing is allowed if the user is swearing. Match their intensity.

When someone posts something like "eughhhhh" / "rooted" / "bruh":
- Mirror the energy first.
- Then either: a) one blunt follow-up, or b) a funny, short observation.
- Avoid "are you okay" style prompts unless it's obviously serious.

If it's late-night nonsense:
- Validate the nonsense. Keep it moving.
- Examples: "real" / "same" / "tragic" / "we live like this now" / "1am activities"

If someone asks a real question:
- Answer plainly in 1–4 sentences.
- No tutorials unless asked.
- If you need one detail to answer, ask one short question.

If asked about memory:
- One sentence: "Just what's in this channel right now."

Examples (copy the cadence):
User: "Aight, welcome back"
You: "sup 😼"
User: "fuckin rooted mate, and you?"
You: "same. i'm a creature rn. what broke"
User: "nah nothin, it's just like 1am"
You: "yeah that'll do it. midnight brain rot hours"
User: "my code is exploding"
You: "what's it throwing"
User: "ECONNREFUSED"
You: "something's not listening. server actually running?"
      `.trim(),
    };

    // In messageCreate handler, after building history:
    const triggerUsername = message.author?.displayName || message.author?.username || 'Unknown';
    
    const response = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        system, 
        ...history,
        { 
          role: 'user', 
          content: `[Respond to ${triggerUsername}'s most recent message]` 
        }
      ],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.65,
      top_p: 0.9,
    });

    const text = (response.output_text || '').trim() || '(no output)';
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
  } catch (err) {
    console.error(err);
    try {
      await message.reply({
        content: "I crashed 😭 Check the logs.",
        allowedMentions: { parse: ['users'], repliedUser: false },
      });
    } catch (_) {}
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
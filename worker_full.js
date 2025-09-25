/**
 * worker_full.js
 * Belaynish Telegram Bot — Cloudflare Worker full rewrite (Replicate webhooks)
 *
 * Requirements (wrangler):
 *  - KV namespaces bound as MEMORY_KV and JOBS_KV
 *  - Secrets set: TELEGRAM_TOKEN, REPLICATE_API_KEY, (optional) HUGGINGFACE_API_KEY, HF_SPACE_URL, HF_URL,
 *    RUNWAY_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, PIXABAY_KEY, STABILITY_KEY, BASE_URL
 *
 * Endpoints:
 *  - POST /webhook                <- Telegram webhook (set from Telegram)
 *  - POST /replicate-webhook      <- Replicate webhook for job updates
 *  - GET  /stream?file=<url>      <- streaming passthrough for large files
 *  - GET  /keepalive              <- health
 *
 * Behavior:
 *  - All outgoing reply text/captions begin with "Belaynish"
 *  - Replicate jobs are created with webhook pointing to /replicate-webhook (so no long polling)
 *  - Jobs are stored in JOBS_KV for state (throttled edits, final delivery, caption edits)
 *  - Memory stored in MEMORY_KV with TTL (MEMORY_TTL_SECONDS)
 */

const TELEGRAM_API_BASE = (token) => `https://api.telegram.org/bot${token}`;
const JOB_PREFIX = "repjob:";
const MEMORY_PREFIX = "memory:";
const DEFAULT_MEMORY_TTL = 10800; // seconds
const MIN_DELTA_PERCENT = 5;
const MIN_INTERVAL_MS = 15000;
const TYPING_INTERVAL_MS = 2500;

function nowMs() { return Date.now(); }
function safeFirst(arr) { return Array.isArray(arr) && arr.length ? arr[0] : null; }

/* ---------- Helpers (stateless) ---------- */

function withPrefix(txt = "") {
  txt = txt === null || txt === undefined ? "" : String(txt);
  return txt.startsWith("Belaynish") ? txt : `Belaynish\n\n${txt}`;
}

function parseAdminIds(env) {
  try {
    return (env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10)).filter(Boolean);
  } catch { return []; }
}
function getOwnerId(env) {
  try { return env.OWNER_ID ? parseInt(env.OWNER_ID, 10) : null; } catch { return null; }
}
function isAdmin(env, userId) {
  if (!userId) return false;
  const owner = getOwnerId(env);
  if (owner && userId === owner) return true;
  const admins = parseAdminIds(env);
  return admins.includes(userId);
}

/* ---------- Telegram API wrappers ---------- */
async function tgApi(env, method, payload, isForm = false) {
  if (!env.TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_TOKEN");
  const url = `${TELEGRAM_API_BASE(env.TELEGRAM_TOKEN)}/${method}`;
  const opts = { method: "POST" };
  if (isForm) opts.body = payload;
  else {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(payload);
  }
  const r = await fetch(url, opts);
  const txt = await r.text().catch(() => null);
  try { return JSON.parse(txt); } catch { return null; }
}

async function sendMessage(env, chatId, text, extra = {}) {
  const payload = Object.assign({ chat_id: chatId, parse_mode: "HTML", text: withPrefix(String(text || "")) }, extra);
  return tgApi(env, "sendMessage", payload);
}
async function editMessageText(env, chatId, messageId, text, extra = {}) {
  const payload = Object.assign({ chat_id: chatId, message_id: messageId, parse_mode: "HTML", text: withPrefix(String(text || "")) }, extra);
  return tgApi(env, "editMessageText", payload);
}
async function editMessageCaption(env, chatId, messageId, caption, extra = {}) {
  const payload = Object.assign({ chat_id: chatId, message_id: messageId, parse_mode: "HTML", caption: withPrefix(String(caption || "")) }, extra);
  return tgApi(env, "editMessageCaption", payload);
}
async function sendPhoto(env, chatId, photoUrl, caption) {
  const payload = { chat_id: chatId, photo: photoUrl };
  if (caption) payload.caption = withPrefix(String(caption));
  return tgApi(env, "sendPhoto", payload);
}
async function sendVideo(env, chatId, videoUrl, caption) {
  const payload = { chat_id: chatId, video: videoUrl };
  if (caption) payload.caption = withPrefix(String(caption));
  return tgApi(env, "sendVideo", payload);
}
async function sendDocument(env, chatId, docUrl, caption) {
  const payload = { chat_id: chatId, document: docUrl };
  if (caption) payload.caption = withPrefix(String(caption));
  return tgApi(env, "sendDocument", payload);
}
async function sendChatAction(env, chatId, action = "typing") {
  return tgApi(env, "sendChatAction", { chat_id: chatId, action });
}
async function sendVoiceBlob(env, chatId, arrayBuffer, filename = "tts.mp3") {
  if (!env.TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_TOKEN");
  const url = `${TELEGRAM_API_BASE(env.TELEGRAM_TOKEN)}/sendVoice`;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
  form.append("voice", blob, filename);
  const res = await fetch(url, { method: "POST", body: form });
  const txt = await res.text().catch(()=>null);
  try { return JSON.parse(txt); } catch { return null; }
}

/* ---------- KV memory helpers ---------- */
async function getMemory(env, chatId) {
  try {
    const raw = await env.MEMORY_KV.get(`${MEMORY_PREFIX}${chatId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
async function saveMemory(env, chatId, history) {
  try {
    const ttl = parseInt(env.MEMORY_TTL_SECONDS || String(DEFAULT_MEMORY_TTL), 10) || DEFAULT_MEMORY_TTL;
    await env.MEMORY_KV.put(`${MEMORY_PREFIX}${chatId}`, JSON.stringify(history), { expirationTtl: ttl });
  } catch { /* ignore */ }
}
async function clearMemory(env, chatId) {
  try { await env.MEMORY_KV.delete(`${MEMORY_PREFIX}${chatId}`); } catch {}
}

/* ---------- Hugging Face helpers + model map ---------- */
function getHfModelUrl(env, key) {
  const map = {
    llama2: env.MODEL_LLAMA2 || env.HF_URL,
    mistral: env.MODEL_MISTRAL || env.HF_URL,
    flan_t5: env.MODEL_FLAN_T5 || env.HF_URL,
    falcon: env.MODEL_FALCON || env.HF_URL,
    gpt2: env.MODEL_GPT2 || env.HF_URL,
    bloom: env.MODEL_BLOOM || env.HF_URL,
    default: env.MODEL || env.HF_URL || env.HF_MODEL || env.MODEL_DEFAULT
  };
  return map[key] || map.default;
}

async function callHfSpace(env, prompt, spaceUrl) {
  if (!spaceUrl) throw new Error("HF_SPACE_URL not configured");
  const base = spaceUrl.replace(/\/$/, "");
  const candidates = [`${base}/run/predict`, `${base}/api/predict`, base];
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [prompt] }),
        // no signal here
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (data?.data && data.data.length) return String(data.data[0]);
      if (data?.generated_text) return String(data.generated_text);
      if (typeof data === "string" && data.length) return data;
    } catch (e) {
      // try next
    }
  }
  throw new Error("HF Space did not return output");
}

async function callHfApi(env, prompt, modelUrl) {
  if (!modelUrl || !env.HUGGINGFACE_API_KEY) throw new Error("HF API not configured");
  const r = await fetch(modelUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HUGGINGFACE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: prompt })
  });
  if (!r.ok) throw new Error("HF API call failed");
  const j = await r.json();
  if (Array.isArray(j) && j[0]?.generated_text) return j[0].generated_text;
  if (j?.generated_text) return j.generated_text;
  if (j?.data && j.data[0]) return j.data[0];
  return JSON.stringify(j).slice(0, 4000);
}

/* ---------- Unofficial Google Translate (no key) ---------- */
async function translateUnofficial(text, to = "en") {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(url);
    if (!r.ok) return text;
    const j = await r.json();
    if (Array.isArray(j) && Array.isArray(j[0])) return j[0].map(p => p[0]).join("");
    return text;
  } catch { return text; }
}

/* ---------- Replicate helpers (create with webhook) ---------- */
async function callReplicateCreate(env, versionOrModel, input) {
  if (!env.REPLICATE_API_KEY) throw new Error("REPLICATE_API_KEY missing");
  const payload = { version: versionOrModel, input: input || {} };
  // attach webhook to our worker endpoint (so Replicate will POST updates)
  if (env.BASE_URL) {
    payload.webhook = `${env.BASE_URL.replace(/\/$/, "")}/replicate-webhook`;
    // request events that include processing updates (Replicate supports some event filters)
    payload.webhook_events_filter = ["processing", "starting", "completed", "failed"];
  }
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { Authorization: `Token ${env.REPLICATE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const txt = await r.text();
  if (!r.ok) {
    throw new Error("Replicate create failed: " + txt);
  }
  try { return JSON.parse(txt); } catch { return null; }
}

/* ---------- Runway / Stability / Pixabay / ElevenLabs ---------- */
async function callRunway(env, endpoint, model, input) {
  if (!env.RUNWAY_API_KEY) throw new Error("RUNWAY_API_KEY missing");
  const url = endpoint.replace(/\/$/, "");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RUNWAY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input })
  });
  if (!r.ok) throw new Error("Runway call failed");
  return r.json();
}

async function callStabilityImage(env, prompt, opts = {}) {
  if (!env.STABILITY_KEY) throw new Error("STABILITY_KEY missing");
  const url = "https://api.stability.ai/v1/generation/stable-diffusion-v1-5/text-to-image";
  const payload = { text_prompts: [{ text: prompt }], cfg_scale: opts.cfg_scale || 7, height: opts.height || 512, width: opts.width || 512, samples: 1 };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STABILITY_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error("Stability image failed");
  return r.arrayBuffer();
}

async function pixabaySearch(env, query) {
  if (!env.PIXABAY_KEY) throw new Error("PIXABAY_KEY missing");
  const url = `https://pixabay.com/api/?key=${env.PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&per_page=3`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Pixabay failed");
  const j = await r.json();
  return j.hits || [];
}

async function elevenTTS(env, text) {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) throw new Error("ElevenLabs not configured");
  const base = (env.ELEVENLABS_API_URL || "https://api.elevenlabs.io/v1").replace(/\/$/, "");
  const url = `${base}/text-to-speech/${env.ELEVENLABS_VOICE_ID}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=>"");
    throw new Error("ElevenLabs failed: " + txt);
  }
  return r.arrayBuffer();
}

/* ---------- JOB KV helpers ---------- */
async function storeRepJob(env, job) {
  const key = JOB_PREFIX + job.predictionId;
  await env.JOBS_KV.put(key, JSON.stringify(job));
}
async function getRepJob(env, predictionId) {
  const raw = await env.JOBS_KV.get(JOB_PREFIX + predictionId);
  return raw ? JSON.parse(raw) : null;
}
async function deleteRepJob(env, predictionId) {
  await env.JOBS_KV.delete(JOB_PREFIX + predictionId);
}

/* ---------- Percent extraction (from replicate response) ---------- */
function extractPercentFromReplicate(body) {
  if (!body) return null;
  if (typeof body.progress === "number") return Math.round(body.progress * 100);
  if (body.metrics && typeof body.metrics.progress === "number") return Math.round(body.metrics.progress * 100);
  if (Array.isArray(body.logs) && body.logs.length) {
    const last = String(body.logs[body.logs.length - 1] || "");
    const m = last.match(/(\d{1,3})\s?%/);
    if (m) return Math.min(100, Math.max(0, parseInt(m[1], 10)));
    const m2 = last.match(/progress[:=]\s*([0-9.]+)/i);
    if (m2) {
      let p = parseFloat(m2[1]);
      if (p <= 1) p = Math.round(p * 100);
      return Math.min(100, Math.max(0, Math.round(p)));
    }
  }
  return null;
}

/* ---------- Streaming passthrough ---------- */
async function streamPassthrough(url) {
  if (!url) return new Response("Missing file URL", { status: 400 });
  try {
    const upstream = await fetch(url);
    // copy headers where possible
    const headers = {};
    upstream.headers.forEach((v,k) => headers[k] = v);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return new Response("Streaming failed: " + (e.message || String(e)), { status: 502 });
  }
}

/* ---------- Webhook handler for Replicate (progress updates & final outputs) ---------- */
async function handleReplicateWebhook(env, body) {
  try {
    // body should contain 'id' and 'status' and possibly 'output', 'logs', 'metrics', etc.
    const predictionId = body?.id || body?.prediction?.id || null;
    const status = body?.status || body?.prediction?.status || null;

    // fallback chat id if not stored in job
    let job = predictionId ? await getRepJob(env, predictionId) : null;

    // sometimes replicate returns input inside body.input
    const input = (body?.input || body?.prediction?.input) || {};
    const fallbackChatId = input?.telegram_chat_id || input?.chat_id || null;
    const fallbackCaption = input?.caption || input?.prompt || input?.text || null;

    if (!job && (!predictionId && !fallbackChatId)) {
      // nothing to do
      return;
    }

    // if job not found but we have chat id and prediction id, create a minimal job to attempt progress edits
    if (!job && predictionId) {
      job = { predictionId, chatId: fallbackChatId || null, caption: fallbackCaption || null, lastPercent: -1, lastUpdate: 0 };
      await storeRepJob(env, job);
    }

    if (!job) return;

    // progress updates
    const percent = extractPercentFromReplicate(body);
    const now = nowMs();
    const shouldUpdate = (typeof percent === "number" && (percent - (job.lastPercent || -1) >= MIN_DELTA_PERCENT)) || ((now - (job.lastUpdate || 0)) >= MIN_INTERVAL_MS);

    if (shouldUpdate) {
      const pctText = typeof percent === "number" ? `${percent}%` : "processing...";
      const text = `Processing: ${pctText}`;
      try {
        if (job.mediaMessageId) {
          // edit caption on final media if available
          await editMessageCaption(env, job.chatId, job.mediaMessageId, text);
        } else if (job.progressMessageIsMedia && job.progressMessageId) {
          await editMessageCaption(env, job.chatId, job.progressMessageId, text);
        } else if (job.progressMessageId) {
          await editMessageText(env, job.chatId, job.progressMessageId, text);
        } else {
          const sent = await sendMessage(env, job.chatId, text);
          job.progressMessageId = (sent?.result?.message_id || sent?.message_id) || null;
          job.progressMessageIsMedia = Boolean(sent?.result?.photo || sent?.result?.video || sent?.photo || sent?.video);
        }
      } catch (e) {
        // ignore edit failures
      }
      job.lastPercent = typeof percent === "number" ? percent : job.lastPercent;
      job.lastUpdate = now;
      await storeRepJob(env, job);
    }

    // terminal statuses
    if (status === "succeeded" || status === "completed") {
      // outputs can be array or single value; sometimes nested
      const outputs = body?.output || body?.prediction?.output || body?.outputs || [];
      const arr = Array.isArray(outputs) ? outputs : [outputs];

      if (!arr.length || arr.every(x => x === null || x === undefined || (typeof x === "object" && Object.keys(x).length === 0))) {
        await sendMessage(env, job.chatId, "Replicate finished but produced no output.");
      } else {
        // send all outputs
        for (const out of arr) {
          let urlOut = null;
          if (!out) continue;
          if (typeof out === "string") urlOut = out;
          else if (out?.url) urlOut = out.url;
          else if (Array.isArray(out) && typeof out[0] === "string") urlOut = out[0];

          if (urlOut && urlOut.match(/\.(mp4|webm|mov|mkv)(\?|$)/i)) {
            const sent = await sendVideo(env, job.chatId, urlOut, job.caption || "Here is your video");
            const msg_id = (sent?.result?.message_id || sent?.message_id) || null;
            if (msg_id) {
              job.mediaMessageId = msg_id;
              try { await editMessageCaption(env, job.chatId, msg_id, job.caption || "Result"); } catch (e) {}
            }
          } else if (urlOut && urlOut.match(/\.(jpe?g|png|gif)(\?|$)/i)) {
            const sent = await sendPhoto(env, job.chatId, urlOut, job.caption || "Here is your image");
            const msg_id = (sent?.result?.message_id || sent?.message_id) || null;
            if (msg_id) {
              job.mediaMessageId = msg_id;
              try { await editMessageCaption(env, job.chatId, msg_id, job.caption || "Result"); } catch (e) {}
            }
          } else if (urlOut && urlOut.match(/\.(mp3|wav|ogg)(\?|$)/i)) {
            await sendDocument(env, job.chatId, urlOut, job.caption || "Here is your audio");
          } else if (urlOut && urlOut.startsWith("http")) {
            // unknown URL -> send as document (Telegram will fetch)
            const sent = await sendDocument(env, job.chatId, urlOut, job.caption || "Result");
            const msg_id = (sent?.result?.message_id || sent?.message_id) || null;
            if (msg_id && (sent?.result?.video || sent?.result?.photo)) {
              job.mediaMessageId = msg_id;
              try { await editMessageCaption(env, job.chatId, msg_id, job.caption || "Result"); } catch (e) {}
            }
          } else {
            // fallback: send as text
            await sendMessage(env, job.chatId, String(out));
          }
        }
      }
      // cleanup
      await deleteRepJob(env, job.predictionId);
    } else if (status === "failed") {
      await sendMessage(env, job.chatId, "Replicate job failed: " + JSON.stringify(body).slice(0, 2000));
      await deleteRepJob(env, job.predictionId);
    } else {
      // still running; saved above
    }
  } catch (e) {
    console.warn("handleReplicateWebhook error", e.message);
  }
}

/* ---------- Command handler (Telegram update -> /ai ...) ---------- */
async function handleAiCommand(env, message) {
  try {
    if (!message || !message.text) return;
    const raw = message.text.trim();
    if (!raw.startsWith("/ai")) return;
    const parts = raw.split(" ").slice(1);
    if (!parts.length) {
      await sendMessage(env, message.chat.id, "Usage: /ai <mode> <input>\nType /ai help for modes.");
      return;
    }

    const mode = parts[0].toLowerCase();
    const rest = parts.slice(1).join(" ").trim();

    // helper to make a short typing ping before heavy tasks
    async function doTyping() {
      try { await sendChatAction(env, message.chat.id, "typing"); } catch (e) {}
    }

    if (mode === "help") {
      const help = `/ai <mode> <input>

Chat:
  /ai chat [model] <prompt>

Search:
  /ai wiki <topic>
  /ai duck <query>

Translate:
  /ai translate [lang] <text>

Media:
  /ai media <mode> <input>   (t2i,t2v,i2v,v2v,upscale,act,flux,fixface,caption,recon3d)

TTS:
  /ai tts <text>

Replicate direct:
  /ai replicate <ENV_VAR_NAME> <prompt>

Admin:
  /ai post <@channel> <message>
  /ai clear_memory <chatId>
  /ai export_memory <chatId>
`;
      await sendMessage(env, message.chat.id, help);
      return;
    }

    // ----- CHAT -----
    if (mode === "chat") {
      if (!rest) { await sendMessage(env, message.chat.id, "Provide prompt: /ai chat [model] <prompt>"); return; }
      const toks = rest.split(" ");
      let modelKey = null;
      let prompt = rest;
      const knownKeys = ["llama2","mistral","flan_t5","falcon","gpt2","bloom"];
      if (toks.length > 1 && knownKeys.includes(toks[0].toLowerCase())) {
        modelKey = toks[0].toLowerCase();
        prompt = toks.slice(1).join(" ");
      }
      if (!modelKey) modelKey = "llama2";

      const mem = await getMemory(env, message.from.id);
      mem.push({ role: "user", content: prompt });
      const context = mem.map(m => `${m.role}: ${m.content}`).join("\n");

      let answer = null;

      // HF Space
      if (env.HF_SPACE_URL) {
        try {
          await doTyping();
          answer = await callHfSpace(env, context, env.HF_SPACE_URL);
        } catch (e) { console.warn("HF Space error", e.message); }
      }

      // HF API
      if (!answer && env.HUGGINGFACE_API_KEY && (env.HF_URL || getHfModelUrl(env, modelKey))) {
        try {
          await doTyping();
          const hfModelUrl = getHfModelUrl(env, modelKey);
          if (hfModelUrl) answer = await callHfApi(env, context, hfModelUrl);
        } catch (e) { console.warn("HF API error", e.message); }
      }

      // Replicate (fallback) - create job and notify via webhook
      if (!answer && env.REPLICATE_API_KEY && (env.REPLICATE_CHAT_MODEL_GPT5 || env.REPLICATE_CHAT_MODEL_LLAMA2 || env.REPLICATE_CHAT_MODEL_MISTRAL)) {
        try {
          // pick a replicate model env if available
          const repModel = env.REPLICATE_CHAT_MODEL_GPT5 || env.REPLICATE_CHAT_MODEL_LLAMA2 || env.REPLICATE_CHAT_MODEL_MISTRAL;
          await doTyping();
          const created = await callReplicateCreate(env, repModel, { prompt, telegram_chat_id: message.chat.id, telegram_message_id: message.message_id });
          // store job and notify user
          const sent = await sendMessage(env, message.chat.id, "Started Replicate chat job — you'll be notified when it's done.");
          const progressMessageId = (sent?.result?.message_id || sent?.message_id) || null;
          const job = { predictionId: created?.id, chatId: message.chat.id, progressMessageId, progressMessageIsMedia: false, caption: prompt, createdAt: nowMs(), lastPercent: -1 };
          if (created?.id) await storeRepJob(env, job);
          return;
        } catch (e) { console.warn("Replicate chat create error", e.message); }
      }

      if (!answer) {
        const w = await wikiSummary(context);
        const d = await duckDuck(context);
        answer = `${w}\n\nDuck summary:\n${d}`;
      }

      mem.push({ role: "assistant", content: answer });
      await saveMemory(env, message.from.id, mem);
      await sendMessage(env, message.chat.id, answer);
      return;
    }

    // ----- WIKI -----
    if (mode === "wiki") {
      if (!rest) { await sendMessage(env, message.chat.id, "Usage: /ai wiki <topic>"); return; }
      const out = await wikiSummary(rest);
      await sendMessage(env, message.chat.id, out);
      return;
    }

    // ----- DUCK -----
    if (mode === "duck") {
      if (!rest) { await sendMessage(env, message.chat.id, "Usage: /ai duck <query>"); return; }
      const out = await duckDuck(rest);
      await sendMessage(env, message.chat.id, out);
      return;
    }

    // ----- TRANSLATE -----
    if (mode === "translate") {
      if (!rest) { await sendMessage(env, message.chat.id, "Usage: /ai translate [lang] <text>"); return; }
      const toks = rest.split(" ");
      let to = "en";
      let text = rest;
      if (toks.length > 1 && toks[0].length <= 3) { to = toks[0]; text = toks.slice(1).join(" "); }
      const t = await translateUnofficial(text, to);
      await sendMessage(env, message.chat.id, t);
      return;
    }

    // ----- TTS -----
    if (mode === "tts") {
      if (!rest) { await sendMessage(env, message.chat.id, "Usage: /ai tts <text>"); return; }
      if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID) {
        try {
          const ab = await elevenTTS(env, rest);
          await sendVoiceBlob(env, message.chat.id, ab, "tts.mp3");
          return;
        } catch (e) { console.warn("ElevenLabs error", e.message); }
      }
      if (env.REPLICATE_API_KEY && env.REPLICATE_TTS_MODEL) {
        try {
          const created = await callReplicateCreate(env, env.REPLICATE_TTS_MODEL, { text: rest, telegram_chat_id: message.chat.id, telegram_message_id: message.message_id });
          const sent = await sendMessage(env, message.chat.id, "Started Replicate TTS job — you'll be notified when it's done.");
          const progressMessageId = (sent?.result?.message_id || sent?.message_id) || null;
          const job = { predictionId: created?.id, chatId: message.chat.id, progressMessageId, caption: rest, createdAt: nowMs(), lastPercent: -1 };
          if (created?.id) await storeRepJob(env, job);
          return;
        } catch (e) { console.warn("Replicate TTS create error", e.message); }
      }
      await sendMessage(env, message.chat.id, "No TTS provider configured.");
      return;
    }

    // ----- MEDIA -----
    if (mode === "media") {
      const sub = parts[1] ? parts[1].toLowerCase() : null;
      const payload = parts.slice(2).join(" ");
      if (!sub || !payload) { await sendMessage(env, message.chat.id, "Usage: /ai media <mode> <input>. Type /ai help for modes."); return; }

      const repModes = ["flux","fixface","caption","burncaption","recon3d"];
      const runwayModes = ["t2i","t2v","i2v","v2v","upscale","act"];

      // Replicate branch
      if (repModes.includes(sub) && env.REPLICATE_API_KEY) {
        const map = { flux: env.REPLICATE_IMAGE_MODEL, fixface: env.REPLICATE_UPSCALE_MODEL, caption: env.REPLICATE_VIDEO_CAPTION_MODEL, burncaption: env.REPLICATE_VIDEO_CAPTIONED_MODEL, recon3d: env.REPLICATE_3D_MODEL };
        const repModel = map[sub];
        if (!repModel) { await sendMessage(env, message.chat.id, "Replicate model not set for this mode."); return; }
        try {
          const input = (sub === "flux") ? { prompt: payload } : (sub === "fixface" ? { image: payload } : { video: payload });
          // attach telegram details so webhook can find chat/message
          input.telegram_chat_id = message.chat.id;
          input.telegram_message_id = message.message_id;
          const created = await callReplicateCreate(env, repModel, input);
          const sent = await sendMessage(env, message.chat.id, "Started job on Replicate, you'll be updated.");
          const progressMessageId = (sent?.result?.message_id || sent?.message_id) || null;
          const progressIsMedia = Boolean(sent?.result?.photo || sent?.result?.video || sent?.photo || sent?.video);
          const job = { predictionId: created?.id, chatId: message.chat.id, progressMessageId, progressMessageIsMedia, caption: payload, createdAt: nowMs(), lastPercent: -1 };
          if (created?.id) await storeRepJob(env, job);
          return;
        } catch (e) {
          await sendMessage(env, message.chat.id, "Replicate media error: " + (e.message || String(e)));
          return;
        }
      }

      // Runway branch
      if (runwayModes.includes(sub) && env.RUNWAY_API_KEY) {
        try {
          const endpoints = {
            t2i: { url: env.RUNWAY_URL_TEXT_TO_IMAGE, model: env.RUNWAY_MODEL_TEXT_TO_IMAGE },
            t2v: { url: env.RUNWAY_URL_TEXT_TO_VIDEO, model: env.RUNWAY_MODEL_TEXT_TO_VIDEO },
            i2v: { url: env.RUNWAY_URL_IMAGE_TO_VIDEO, model: env.RUNWAY_MODEL_IMAGE_TO_VIDEO },
            v2v: { url: env.RUNWAY_URL_VIDEO_TO_VIDEO, model: env.RUNWAY_MODEL_VIDEO_TO_VIDEO },
            upscale: { url: env.RUNWAY_URL_VIDEO_UPSCALE, model: env.RUNWAY_MODEL_VIDEO_UPSCALE },
            act: { url: env.RUNWAY_URL_CHARACTER_PERFORMANCE, model: env.RUNWAY_MODEL_CHARACTER_PERFORMANCE }
          };
          const cfg = endpoints[sub];
          if (!cfg?.url || !cfg?.model) { await sendMessage(env, message.chat.id, "Runway endpoint/model not configured."); return; }
          const r = await callRunway(env, cfg.url, cfg.model, (sub === "t2i" || sub === "t2v") ? { prompt: payload } : (sub === "i2v" ? { image_url: payload } : { video_url: payload }));
          const out = Array.isArray(r.output) ? r.output[0] : r.output;
          if (!out) { await sendMessage(env, message.chat.id, "Runway returned no output yet."); return; }
          if (sub === "t2i") { await sendPhoto(env, message.chat.id, out, payload); return; }
          await sendVideo(env, message.chat.id, out, payload);
          return;
        } catch (e) {
          await sendMessage(env, message.chat.id, "Runway error: " + (e.message || String(e)));
          return;
        }
      }

      // Stability / Pixabay fallback for t2i
      if (sub === "t2i") {
        if (env.STABILITY_KEY) {
          try {
            const buff = await callStabilityImage(env, payload);
            // best practice: upload binary to R2 and send R2 URL to Telegram
            await sendMessage(env, message.chat.id, "Generated image (binary). Recommended: store in R2 and send URL to user.");
            return;
          } catch (e) { console.warn("Stability error", e.message); }
        }
        if (env.PIXABAY_KEY) {
          try {
            const hits = await pixabaySearch(env, payload);
            if (hits.length) { await sendPhoto(env, message.chat.id, hits[0].largeImageURL, payload); return; }
          } catch (e) { console.warn("Pixabay error", e.message); }
        }
      }

      await sendMessage(env, message.chat.id, "No provider configured for that media mode or provider returned no output.");
      return;
    }

    // ----- REPLICATE DIRECT -----
    if (mode === "replicate") {
      const repEnv = parts[1];
      const promptText = parts.slice(2).join(" ");
      if (!repEnv || !promptText) { await sendMessage(env, message.chat.id, "Usage: /ai replicate <ENV_VAR_NAME> <prompt>"); return; }
      const repModel = env[repEnv];
      if (!repModel) { await sendMessage(env, message.chat.id, `No replicate model found in env as ${repEnv}`); return; }
      try {
        const created = await callReplicateCreate(env, repModel, { prompt: promptText, telegram_chat_id: message.chat.id, telegram_message_id: message.message_id });
        const sent = await sendMessage(env, message.chat.id, "Replicate job started; you'll be notified when done.");
        const progressMessageId = (sent?.result?.message_id || sent?.message_id) || null;
        const job = { predictionId: created?.id, chatId: message.chat.id, progressMessageId, caption: promptText, createdAt: nowMs(), lastPercent: -1 };
        if (created?.id) await storeRepJob(env, job);
        return;
      } catch (e) {
        await sendMessage(env, message.chat.id, "Replicate error: " + (e.message || String(e)));
        return;
      }
    }

    // ----- ADMIN -----
    if (mode === "post") {
      if (!isAdmin(env, message.from?.id)) { await sendMessage(env, message.chat.id, "Admin only command."); return; }
      const channel = parts[1];
      const msg = parts.slice(2).join(" ");
      if (!channel || !msg) { await sendMessage(env, message.chat.id, "Usage: /ai post <@channel_or_channelusername> <message>"); return; }
      try {
        await sendMessage(env, channel, msg);
        await sendMessage(env, message.chat.id, "Posted to " + channel);
      } catch (e) { await sendMessage(env, message.chat.id, "Failed to post: " + (e.message || String(e))); }
      return;
    }

    if (mode === "clear_memory") {
      if (!isAdmin(env, message.from?.id)) { await sendMessage(env, message.chat.id, "Admin only command."); return; }
      const target = parts[1] || String(message.from.id);
      await clearMemory(env, target);
      await sendMessage(env, message.chat.id, `Cleared memory for ${target}`);
      return;
    }

    if (mode === "export_memory") {
      if (!isAdmin(env, message.from?.id)) { await sendMessage(env, message.chat.id, "Admin only command."); return; }
      const target = parts[1] || String(message.from.id);
      const mem = await getMemory(env, target);
      await sendMessage(env, message.chat.id, `Memory for ${target}:\n${JSON.stringify(mem).slice(0,4000)}`);
      return;
    }

    await sendMessage(env, message.chat.id, "Unknown mode. Type /ai help for usage.");
  } catch (err) {
    console.error("handleAiCommand error", err);
    try { await sendMessage(env, message.chat.id, "Error: " + (err.message || String(err))); } catch {}
  }
}

/* ---------- Small utilities used by handlers ---------- */
async function wikiSummary(query) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    const r = await fetch(url);
    if (!r.ok) return "Wikipedia lookup failed.";
    const j = await r.json();
    return j.extract || "No Wikipedia summary found.";
  } catch { return "Wikipedia lookup failed."; }
}
async function duckDuck(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const r = await fetch(url);
    if (!r.ok) return "DuckDuckGo lookup failed.";
    const j = await r.json();
    if (j?.AbstractText) return j.AbstractText;
    const rt = Array.isArray(j?.RelatedTopics) ? j.RelatedTopics[0] : null;
    if (rt?.Text) return rt.Text;
    return "No DuckDuckGo instant answer.";
  } catch { return "DuckDuckGo lookup failed."; }
}

/* ---------- Exported Worker handlers ---------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // health
    if (url.pathname === "/keepalive") return new Response("Belaynish alive");

    // stream passthrough (GET /stream?file=...)
    if (url.pathname === "/stream" && request.method === "GET") {
      const file = url.searchParams.get("file") || url.searchParams.get("url");
      return streamPassthrough(file);
    }

    // Replicate webhook - Replicate posts job updates here
    if (url.pathname === "/replicate-webhook" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        if (!body) return new Response("invalid body", { status: 400 });
        // handle in background and return 200 immediately
        ctx.waitUntil((async () => {
          try { await handleReplicateWebhook(env, body); } catch (e) { console.warn("replicate webhook handler error", e.message); }
        })());
        return new Response("ok");
      } catch (e) {
        return new Response("error: " + e.message, { status: 500 });
      }
    }

    // Telegram webhook - Telegram posts updates here
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json().catch(() => null);
        if (!update) return new Response("invalid update", { status: 400 });

        // only handle message or edited_message for /ai commands (minimally)
        const message = update.message || update.edited_message || null;
        if (message && message.text && message.text.trim().startsWith("/ai")) {
          // run in background so we reply 200 quickly
          ctx.waitUntil((async () => {
            try { await handleAiCommand(env, message); } catch (e) { console.warn("handleAiCommand error", e.message); }
          })());
        }
        return new Response("ok");
      } catch (e) {
        return new Response("error: " + e.message, { status: 500 });
      }
    }

    return new Response("Belaynish Worker: endpoint not found", { status: 404 });
  }
};


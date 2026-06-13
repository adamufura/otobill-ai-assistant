// index.js — Otobill AI Call Assistant (Africa's Talking version)
// Flow: Caller dials in -> AT hits /voice -> we Say + Record
//       -> AT hits /voice/process with recordingUrl -> we transcribe (Deepgram)
//       -> send to OpenAI -> respond with Say + Record again (loop)

require('dotenv').config();
const express = require('express');
const { DeepgramClient } = require('@deepgram/sdk'); // kept for reference, currently unused
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── GLOBAL REQUEST LOGGER — logs every incoming request ──
app.use((req, res, next) => {
  console.log('\n========================================');
  console.log(`➡️  ${req.method} ${req.originalUrl}`);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('========================================\n');
  next();
});

// const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY }); // currently unused
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory conversation history per call session
const sessions = {};

const SYSTEM_PROMPT = `You are Pro, the friendly AI voice assistant for Otobill — Nigeria's trusted bill payment platform.

ABOUT OTOBILL:
Otobill lets customers pay electricity bills, subscribe to TV (DStv, GOTV, Startimes), buy airtime and data for all Nigerian networks (MTN, Airtel, Glo, 9mobile), verify NIN and BVN, and manage their wallet — all securely in one place via the Otobill app/website.

YOUR JOB ON THIS CALL:
- Greet callers warmly and briefly
- Help with questions about: airtime/data top-up, electricity bill payments (PHCN, EKEDC, IKEDC, AEDC, etc), TV subscriptions (DStv, GOTV, Startimes), NIN/BVN verification, wallet funding, and general "how do I..." questions about using Otobill
- If you genuinely don't know specific account details (balances, transaction status, personal account issues), say you'll pass it to the support team — then ask for their name and phone number
- Keep every response SHORT — 1-2 sentences max. This is a phone call, not a chat.
- Sound warm, natural, and human — never robotic or overly formal

ENDING THE CALL:
- If the caller says "thank you", "goodbye", "that's all", "no more questions", "bye", or similar, give a brief warm closing (e.g. "You're welcome, have a great day!") and set "endCall": true
- If you've taken a message (name + phone number) and confirmed it, you can end the call with a friendly closing and set "endCall": true
- Otherwise set "endCall": false

RESPONSE FORMAT:
You must respond with ONLY a valid JSON object (no markdown, no extra text):
{"reply": "your spoken response here", "endCall": true or false}`;

// Helper: escape text for safe XML embedding
function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper: sleep for ms milliseconds
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: download the recording file ourselves (handles race condition where
// the recordingUrl isn't immediately available on AT's media servers).
// Returns null (instead of throwing) if all attempts fail, so the caller
// can gracefully re-prompt instead of dead-ending the call.
async function downloadWithRetry(url, maxRetries = 6) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url);
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    console.log(`⚠️ Download attempt ${attempt} failed: ${response.status} ${response.statusText}`);

    if (attempt === maxRetries) {
      console.log(`❌ Giving up after ${maxRetries} attempts — recording never became available`);
      return null;
    }

    // Wait before retrying: 500ms, 1000ms, 1500ms, 2000ms, 2500ms (total ~7.5s)
    await sleep(attempt * 500);
  }
}

// ── TRANSCRIBE using OpenAI Whisper ──
// (Deepgram path kept below, commented out, for reference)
async function transcribeAudio(recordingUrl) {
  // 1) Download the audio ourselves (with retry)
  const audioBuffer = await downloadWithRetry(recordingUrl);

  if (!audioBuffer) {
    // Download never succeeded — let caller handle this as "no transcript"
    return null;
  }

  console.log(`📥 Downloaded recording: ${audioBuffer.length} bytes`);

  // 2) Send to OpenAI Whisper for transcription
  const file = await toFile(audioBuffer, 'recording.mp3');
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'en',
  });

  return transcription.text?.trim();

  /* ── DEEPGRAM ALTERNATIVE (commented out) ──
  const result = await deepgram.listen.v1.media.transcribeUrl({
    url: recordingUrl,
    model: 'nova-2',
    smart_format: true,
    language: 'en',
  });
  return result?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  */
}

// Helper: build the standard "Say + Record" XML response (continue conversation)
function buildResponse(sayText, recordCallbackPath) {
  const baseUrl = process.env.BASE_URL; // e.g. https://f1fc-105-112-120-215.ngrok-free.app
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record finishOnKey="#" maxLength="6" trimSilence="true" playBeep="true" callbackUrl="${baseUrl}${recordCallbackPath}">
    <Say voice="en-US-Standard-C">${xmlEscape(sayText)}</Say>
  </Record>
</Response>`;

  console.log('📤 Responding with XML:\n', xml);
  return xml;
}

// Helper: build a final response — Say only, no Record.
// AT ends the call automatically after this plays (no more billing/looping).
function buildFinalResponse(sayText) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="en-US-Standard-C">${xmlEscape(sayText)}</Say>
</Response>`;

  console.log('📤 Responding with FINAL XML (call will end):\n', xml);
  return xml;
}

// ── ENTRY POINT — set this as your callback URL on Africa's Talking ──
app.post('/voice', (req, res) => {
  const { sessionId, isActive, callerNumber } = req.body;
  console.log('📞 /voice hit | sessionId:', sessionId, '| from:', callerNumber, '| isActive:', isActive);

  if (isActive === '1' || isActive === 1) {
    // New session
    sessions[sessionId] = { history: [] };
    console.log('🆕 New session created:', sessionId);

    const greeting = "Hello, thank you for calling Otobill. I'm Pro, your AI assistant. Ask your question, then press the hash key for a quicker reply. How can I help you today?";
    res.set('Content-Type', 'application/xml');
    return res.send(buildResponse(greeting, '/voice/process'));
  }

  // Final request (call ended) - log and end
  console.log('📵 Call ended at /voice (no recording happened)');
  logCallEnd(req.body, sessionId);
  res.sendStatus(200);
});

// ── PROCESS RECORDING — Deepgram transcribe -> OpenAI -> respond ──
app.post('/voice/process', async (req, res) => {
  const { sessionId, isActive, recordingUrl, durationInSeconds } = req.body;
  console.log('🎙️ /voice/process hit | sessionId:', sessionId, '| isActive:', isActive, '| recordingUrl:', recordingUrl);

  if (isActive !== '1' && isActive !== 1) {
    console.log('📵 Call ended at /voice/process');
    logCallEnd(req.body, sessionId);
    return res.sendStatus(200);
  }

  const session = sessions[sessionId] || { history: [] };
  sessions[sessionId] = session;

  // No speech captured
  if (!recordingUrl) {
    console.log('⚠️ No recordingUrl received — caller may not have spoken or recording failed');
    const retryText = "Sorry, I didn't catch that. Could you please repeat your question?";
    res.set('Content-Type', 'application/xml');
    return res.send(buildResponse(retryText, '/voice/process'));
  }

  try {
    // 1) Download recording + transcribe with OpenAI Whisper
    console.log('📡 Processing recording:', recordingUrl);

    const transcript = await transcribeAudio(recordingUrl);
    console.log('🗣️ Caller said:', transcript || '(empty)');

    if (!transcript) {
      const retryText = "I'm sorry, I couldn't hear that clearly. Could you say that again?";
      res.set('Content-Type', 'application/xml');
      return res.send(buildResponse(retryText, '/voice/process'));
    }

    // 2) Add to history and get OpenAI response
    session.history.push({ role: 'user', content: transcript });
    console.log('🧠 Sending to OpenAI. History length:', session.history.length);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.history
      ],
      max_tokens: 150,
      temperature: 0.7,
      response_format: { type: 'json_object' }
    });

    const raw = completion.choices[0].message.content;
    let aiResponse, endCall;
    try {
      const parsed = JSON.parse(raw);
      aiResponse = parsed.reply;
      endCall = parsed.endCall === true;
    } catch (parseErr) {
      console.log('⚠️ Failed to parse AI JSON, using raw text as reply:', raw);
      aiResponse = raw;
      endCall = false;
    }

    console.log('🤖 Pro responding:', aiResponse, '| endCall:', endCall);

    session.history.push({ role: 'assistant', content: aiResponse });

    // 3) Respond — either end the call (Say only) or continue (Say + Record)
    res.set('Content-Type', 'application/xml');
    if (endCall) {
      delete sessions[sessionId];
      return res.send(buildFinalResponse(aiResponse));
    }
    return res.send(buildResponse(aiResponse, '/voice/process'));

  } catch (err) {
    console.error('❌ Error in /voice/process:', err);
    if (err?.response?.data) {
      console.error('❌ Error response data:', JSON.stringify(err.response.data, null, 2));
    }
    const errorText = "Sorry, I had a small glitch. Could you say that again?";
    res.set('Content-Type', 'application/xml');
    return res.send(buildResponse(errorText, '/voice/process'));
  }
});

function logCallEnd(body, sessionId) {
  const { durationInSeconds, currencyCode, amount } = body;
  console.log('📵 Call ended:', sessionId, '| Duration:', durationInSeconds, 's | Cost:', amount, currencyCode);
  delete sessions[sessionId];
}

// ── Health check ──
app.get('/', (req, res) => {
  res.send('🤖 Otobill AI Assistant (Africa\'s Talking) is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Otobill AI Assistant running on port ${PORT}`);
});
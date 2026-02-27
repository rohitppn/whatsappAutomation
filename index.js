import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import baileys from '@whiskeysockets/baileys';
import { google } from 'googleapis';
import P from 'pino';
import qrcode from 'qrcode-terminal';

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys;

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const STUDENTS_SHEET_NAME = process.env.STUDENTS_SHEET_NAME || 'Sheet3';
const PATIENTS_SHEET_NAME = process.env.PATIENTS_SHEET_NAME || 'Sheet4';
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const GOOGLE_SERVICE_ACCOUNT_JSON_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || '';

const WEBINAR_LINK =
  process.env.WEBINAR_LINK ||
  'https://drruchitamehta.exlyapp.com/checkout/707b6532-7bbe-40fd-bd76-104c6dc459c4';
const PATIENT_LINK =
  process.env.PATIENT_LINK ||
  'https://drruchitamehta.exlyapp.com/checkout/f92410b4-99bf-4da7-8d97-965cff79f1ea';
const DIABETES_WEBINAR_LINK =
  process.env.DIABETES_WEBINAR_LINK ||
  'https://drruchitamehta.exlyapp.com/checkout/8392be04-0a17-4c40-92a4-9dfc6f418140';
const TYPE1_LINK =
  process.env.TYPE1_LINK ||
  'https://drruchitamehta.exlyapp.com/checkout/d3b56137-7abc-4ecf-b8b6-5af21a31f3b7';
const OTHER_LINK = process.env.OTHER_LINK || TYPE1_LINK;

const FOLLOWUP_HOURS_1 = Number(process.env.FOLLOWUP_HOURS_1 || '24');
const FOLLOWUP_HOURS_2 = Number(process.env.FOLLOWUP_HOURS_2 || '48');
const FOLLOWUP_HOURS_3 = Number(process.env.FOLLOWUP_HOURS_3 || '72');
const REPLY_DELAY_MIN_SECONDS = Number(process.env.REPLY_DELAY_MIN_SECONDS || '0');
const REPLY_DELAY_MAX_SECONDS = Number(process.env.REPLY_DELAY_MAX_SECONDS || '60');
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || '';
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';
const USE_PAIRING_CODE = String(process.env.USE_PAIRING_CODE || 'false').toLowerCase() === 'true';
const PAIRING_PHONE_NUMBER = (process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, '');

const logger = P({ level: process.env.LOG_LEVEL || 'info' });

const sessions = new Map();
const followupTimers = new Map();
const knownUsers = new Set();

function norm(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function yesNo(v) {
  const n = norm(v);
  if (['yes', 'y', '1', 'haan', 'ha'].includes(n)) return 'Yes';
  if (['no', 'n', '2', 'na', 'nah'].includes(n)) return 'No';
  return null;
}

function getPhoneFromJid(jid) {
  return (jid.split('@')[0] || '').split(':')[0];
}

function canonicalPhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  const min = Number.isFinite(REPLY_DELAY_MIN_SECONDS) ? REPLY_DELAY_MIN_SECONDS : 0;
  const max = Number.isFinite(REPLY_DELAY_MAX_SECONDS) ? REPLY_DELAY_MAX_SECONDS : 60;
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(0, Math.max(min, max));
  const seconds = lo + Math.random() * (hi - lo);
  return Math.round(seconds * 1000);
}

function readJsonFileMaybe(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) return null;
  return fs.readFileSync(resolved, 'utf8').trim();
}

function normalizeServiceAccountJson(raw, filePath) {
  let payload = String(raw || '').trim();

  // If GOOGLE_SERVICE_ACCOUNT_JSON is accidentally a file path, load it.
  if (payload && (payload.startsWith('/') || payload.endsWith('.json')) && !payload.startsWith('{')) {
    const byPath = readJsonFileMaybe(payload);
    if (byPath) payload = byPath;
  }

  if (!payload && filePath) {
    const byPath = readJsonFileMaybe(filePath);
    if (byPath) payload = byPath;
  }

  if (!payload) return null;

  if (payload.startsWith('base64:')) {
    try {
      payload = Buffer.from(payload.slice('base64:'.length), 'base64').toString('utf8');
    } catch (err) {
      logger.error({ err }, 'invalid base64 in GOOGLE_SERVICE_ACCOUNT_JSON');
      return null;
    }
  }

  try {
    const parsed = JSON.parse(payload);
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return parsed;
  } catch (err) {
    logger.error({ err }, 'invalid GOOGLE_SERVICE_ACCOUNT_JSON');
    return null;
  }
}

function buildSheetsClient() {
  if (!GOOGLE_SHEET_ID) return null;

  const creds = normalizeServiceAccountJson(
    GOOGLE_SERVICE_ACCOUNT_JSON,
    GOOGLE_SERVICE_ACCOUNT_JSON_PATH
  );
  if (!creds) return null;

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

function unwrapMessageContent(message) {
  if (!message) return null;
  let m = message;
  for (let i = 0; i < 5; i += 1) {
    if (m.ephemeralMessage?.message) {
      m = m.ephemeralMessage.message;
      continue;
    }
    if (m.viewOnceMessage?.message) {
      m = m.viewOnceMessage.message;
      continue;
    }
    if (m.viewOnceMessageV2?.message) {
      m = m.viewOnceMessageV2.message;
      continue;
    }
    if (m.viewOnceMessageV2Extension?.message) {
      m = m.viewOnceMessageV2Extension.message;
      continue;
    }
    break;
  }
  return m;
}

function getIncomingText(msg) {
  const message = unwrapMessageContent(msg.message);
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.buttonsResponseMessage?.selectedDisplayText ||
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.listResponseMessage?.title ||
    message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  ).trim();
}

function entryMessage() {
  return (
    'Hello 👋\n\n' +
    'Welcome to Dr. Ruchita Mehta  - Clinic & Academy\n\n' +
    'We are glad you connected 💙\n\n' +
    'Please let us know how we can support you:\n\n' +
    '1. Diabetes care\n' +
    '2. Other health concerns like thyroid, obesity\n' +
    '3. Professional certification (Diabetes Coach Program)\n\n' +
    'Reply with your choice 🙂'
  );
}

function diabetesIntro() {
  return (
    'Thank you for reaching out 💙\n\n' +
    'We help patients manage & reverse Diabetes naturally using:\n\n' +
    '✔ Personalized Nutrition\n' +
    '✔ Lifestyle correction\n' +
    '✔ Root-cause analysis\n' +
    '✔ Medicine reduction support (if applicable)\n\n' +
    'To understand your case, please share:\n\n' +
    '• Name\n' +
    '• Age\n' +
    '• Email\n' +
    '• Current Medication (if any)\n' +
    '• Contact Number\n\n' +
    'Our team will review and guide you for the best consultation plan 🩺'
  );
}

function otherIntro() {
  return (
    'Hi 👋 Thank you for reaching out to Dr. Ruchita Mehta – Clinic & Academy 💙\n' +
    'Before we guide you further, could you please share:\n\n' +
    '• Name\n' +
    '• Age\n' +
    '• Email\n' +
    '• Current Medication (if any)\n' +
    '• Contact Number\n' +
    '• What health concern are you facing?\n' +
    '• Since how long?\n\n' +
    'This will help our team understand your case better and suggest the right support for you ✨'
  );
}

function studentIntro() {
  return (
    'Amazing  Our Certified Diabetes Specialist Program is designed for:\n\n' +
    '• Nutritionists\n' +
    '• Health Coaches\n' +
    '• Doctors\n' +
    '• Fitness Trainers\n' +
    '• Students\n\n' +
    'Would you like to attend our upcoming FREE WEBINAR\n\n' +
    'Share Your Details Below to get the details\n\n' +
    '• Name\n' +
    '• Age\n' +
    '• Email\n' +
    '• WhatsApp Number'
  );
}

function parseBulk(text, expected) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < expected.length) return null;

  const data = {};
  for (let i = 0; i < expected.length; i += 1) data[expected[i]] = lines[i] || '';
  return data;
}

function confirmPatient(d) {
  return (
    `Name: ${d.name || ''}\n` +
    `Age: ${d.age || ''}\n` +
    `Email: ${d.email || ''}\n` +
    `Current Medication: ${d.current_medication || ''}\n` +
    `Contact Number : ${d.contact_number || ''}\n` +
    'Is this correct? (Yes/No)'
  );
}

function confirmStudent(d) {
  return (
    `Name: ${d.name || ''}\n` +
    `Age: ${d.age || ''}\n` +
    `Email: ${d.email || ''}\n` +
    `WhatsApp Number: ${d.contact_number || ''}\n` +
    'Is this correct? (Yes/No)'
  );
}

async function appendRow(sheets, sheetName, row, jid) {
  if (!sheets || !GOOGLE_SHEET_ID) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
  logger.info({ jid, sheetName }, 'sheet row appended');
}

async function phoneExistsInSheet(sheets, sheetName, phone) {
  if (!sheets || !phone) return false;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${sheetName}!A:T`
    });
    const rows = res.data.values || [];
    const normalizedPhone = canonicalPhone(phone);
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i] || [];
      const rowPhone = canonicalPhone(row[3] || '');
      if (rowPhone && rowPhone === normalizedPhone) return true;
    }
    return false;
  } catch (err) {
    logger.error({ err, sheetName }, 'failed sheet lookup by phone');
    return false;
  }
}

async function isExistingUser(sheets, phone) {
  const normalized = canonicalPhone(phone);
  if (!normalized) return false;
  if (knownUsers.has(normalized)) return true;

  const inStudent = await phoneExistsInSheet(sheets, STUDENTS_SHEET_NAME, normalized);
  const inPatient = inStudent ? true : await phoneExistsInSheet(sheets, PATIENTS_SHEET_NAME, normalized);
  if (inStudent || inPatient) knownUsers.add(normalized);
  return inStudent || inPatient;
}

async function generateAiReply(userText) {
  if (!MISTRAL_API_KEY) {
    return 'Thanks for your message. Our team has your details and will continue this chat with you.';
  }

  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MISTRAL_API_KEY}`
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are assistant for Dr. Ruchita Mehta Clinic & Academy. Reply briefly, helpful, and professional.'
          },
          { role: 'user', content: userText }
        ],
        temperature: 0.4
      })
    });

    if (!response.ok) throw new Error(`mistral status ${response.status}`);
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const joined = content
        .map((item) => (typeof item?.text === 'string' ? item.text : ''))
        .join(' ')
        .trim();
      if (joined) return joined;
    }
    return 'Thanks for your message. Our team has your details and will continue this chat with you.';
  } catch (err) {
    logger.error({ err }, 'failed AI reply generation');
    return 'Thanks for your message. Our team has your details and will continue this chat with you.';
  }
}

async function shouldSendFollowup(sheets, sheetName, phone, takeColIndex) {
  if (!sheets || !phone) return true;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${sheetName}!A:T`
    });
    const rows = res.data.values || [];
    let latest = null;
    for (let i = rows.length - 1; i >= 1; i -= 1) {
      const row = rows[i] || [];
      const rowPhone = String(row[3] || '').replace(/\D/g, '');
      if (rowPhone && rowPhone === String(phone).replace(/\D/g, '')) {
        latest = row;
        break;
      }
    }
    if (!latest) return true;
    const take = String(latest[takeColIndex] || '').trim().toLowerCase();
    return !(take === 'no');
  } catch (err) {
    logger.error({ err, sheetName }, 'failed to read followup flag; defaulting to send');
    return true;
  }
}

function clearFollowups(jid) {
  const timers = followupTimers.get(jid);
  if (!timers) return;
  for (const t of timers) clearTimeout(t);
  followupTimers.delete(jid);
}

function scheduleFollowups(sock, sheets, session) {
  clearFollowups(session.jid);

  const delays = [FOLLOWUP_HOURS_1, FOLLOWUP_HOURS_2, FOLLOWUP_HOURS_3]
    .filter((h) => Number.isFinite(h) && h > 0)
    .map((h) => h * 60 * 60 * 1000);

  const messages =
    session.flow === 'student'
      ? [
          `Reminder: webinar details are here ${WEBINAR_LINK}`,
          'Checking in on your interest. Reply if you need guidance.',
          'Final follow-up: we have your data, we will get back to you soon.'
        ]
      : [
          `Follow-up: consultation link ${isType1(session.data.diabetes_type) ? TYPE1_LINK : PATIENT_LINK}`,
          `Webinar link: ${DIABETES_WEBINAR_LINK}`,
          'Final follow-up: we have your data, we will get back to you soon.'
        ];

  const timers = [];
  for (let i = 0; i < delays.length && i < messages.length; i += 1) {
    timers.push(
      setTimeout(async () => {
        const sheetName = session.flow === 'student' ? STUDENTS_SHEET_NAME : PATIENTS_SHEET_NAME;
        const takeColIndex = session.flow === 'student' ? 12 : 19;
        const ok = await shouldSendFollowup(sheets, sheetName, session.data.contact_number, takeColIndex);
        if (!ok) return;
        try {
          await sock.sendMessage(session.jid, { text: messages[i] });
        } catch (err) {
          logger.error({ err, jid: session.jid }, 'failed follow-up send');
        }
      }, delays[i])
    );
  }

  followupTimers.set(session.jid, timers);
}

function isType1(v) {
  return norm(v).includes('type1');
}

async function saveStudent(sheets, s) {
  const d = s.data;
  const row = [
    `STU-${Date.now()}`,
    d.name || '',
    d.age || '',
    d.contact_number || '',
    d.email || '',
    d.best_describes || '',
    d.best_describes || '',
    d.training_goal || '',
    d.webinar_interest || 'Yes',
    WEBINAR_LINK,
    new Date().toISOString(),
    '',
    'Yes'
  ];
  await appendRow(sheets, STUDENTS_SHEET_NAME, row, s.jid);
  knownUsers.add(canonicalPhone(d.contact_number || s.phone));
  knownUsers.add(canonicalPhone(s.phone));
}

async function savePatient(sheets, s) {
  const d = s.data;
  const others = d.other_concern
    ? `${d.other_concern}${d.other_since ? ` | Since: ${d.other_since}` : ''}`
    : '';

  const row = [
    `PAT-${Date.now()}`,
    d.name || '',
    d.age || '',
    d.contact_number || '',
    d.email || '',
    '',
    d.current_medication || '',
    d.diabetes_type || '',
    d.diabetes_years || '',
    d.latest_fasting_pp || '',
    d.main_goal || '',
    new Date().toISOString(),
    '',
    others,
    isType1(d.diabetes_type) ? 'Yes' : '',
    d.type1_since_diagnosed || '',
    d.type1_latest_values || '',
    d.type1_high_low || '',
    d.type1_symptoms || '',
    'Yes'
  ];

  await appendRow(sheets, PATIENTS_SHEET_NAME, row, s.jid);
  knownUsers.add(canonicalPhone(d.contact_number || s.phone));
  knownUsers.add(canonicalPhone(s.phone));
}

function newSession(jid) {
  const s = {
    jid,
    phone: canonicalPhone(getPhoneFromJid(jid)),
    flow: null,
    step: 'choose',
    data: { contact_number: canonicalPhone(getPhoneFromJid(jid)) }
  };
  sessions.set(jid, s);
  return s;
}

async function finishFlow(sock, sheets, s) {
  if (s.flow === 'student') await saveStudent(sheets, s);
  else await savePatient(sheets, s);

  scheduleFollowups(sock, sheets, s);
  sessions.delete(s.jid);
}

async function handleChoice(sock, s, text) {
  const t = norm(text);
  if (t === '1' || t.includes('diabetes')) {
    s.flow = 'patient';
    s.step = 'p_collect';
    await sock.sendMessage(s.jid, { text: diabetesIntro() });
    return;
  }
  if (t === '2' || t.includes('other')) {
    s.flow = 'other';
    s.step = 'o_collect';
    await sock.sendMessage(s.jid, { text: otherIntro() });
    return;
  }
  if (t === '3' || t.includes('professional') || t.includes('certification')) {
    s.flow = 'student';
    s.step = 's_collect';
    await sock.sendMessage(s.jid, { text: studentIntro() });
    return;
  }
  await sock.sendMessage(s.jid, { text: 'Reply with 1, 2, or 3 🙂' });
}

async function handlePatientFlow(sock, sheets, s, text) {
  if (s.step === 'p_collect') {
    const bulk = parseBulk(text, ['name', 'age', 'email', 'current_medication', 'contact_number']);
    if (!bulk) {
      await sock.sendMessage(s.jid, {
        text: 'Please send details in 5 lines:\nName\nAge\nEmail\nCurrent Medication\nContact Number'
      });
      return;
    }
    Object.assign(s.data, bulk);
    s.step = 'p_confirm';
    await sock.sendMessage(s.jid, { text: confirmPatient(s.data) });
    return;
  }

  if (s.step === 'p_confirm') {
    const ans = yesNo(text);
    if (!ans) {
      await sock.sendMessage(s.jid, { text: 'Is this correct? (Yes/No)' });
      return;
    }
    if (ans === 'No') {
      s.step = 'p_collect';
      await sock.sendMessage(s.jid, { text: 'Please re-send your 5 details in new lines.' });
      return;
    }

    s.step = 'p_type';
    await sock.sendMessage(s.jid, {
      text: 'Which type of Diabetes?\n\n(Type 1 / Type 2 / Prediabetes / Gestational)'
    });
    return;
  }

  if (s.step === 'p_type') {
    s.data.diabetes_type = text;

    if (isType1(text)) {
      s.step = 't1_intro';
      await sock.sendMessage(s.jid, {
        text:
          'Hi 👋\n\n' +
          'Thank you for reaching out to Dr Ruchita Mehta 🙂\n' +
          'I personally understand Type 1 closely, as I have been managing Type 1 cases since 2012 and have helped many clients achieve more stable sugars and better energy levels with the right nutrition and lifestyle support.\n\n' +
          'Managing sugars daily can feel overwhelming sometimes, but with the right guidance, stability is possible 🙂\n\n' +
          'To guide you properly, I need a few quick details 👇\n\n' +
          '1️⃣ Since how many years diagnosed?\n' +
          '2️⃣ Latest Fasting & PP sugar values\n' +
          '3️⃣ Do you experience frequent sugar highs or lows?\n' +
          '4️⃣ Any symptoms like fatigue, weakness, weight changes or mood swings?'
      });
      s.step = 't1_answers';
      return;
    }

    s.step = 'p_years';
    await sock.sendMessage(s.jid, { text: 'Since how many years?' });
    return;
  }

  if (s.step === 'p_years') {
    s.data.diabetes_years = text;
    s.step = 'p_values';
    await sock.sendMessage(s.jid, { text: 'Latest Fasting & PP sugar values (if available):' });
    return;
  }

  if (s.step === 'p_values') {
    s.data.latest_fasting_pp = text;
    s.step = 'p_goal';
    await sock.sendMessage(s.jid, {
      text:
        'What is your main goal right now?\n' +
        'A) Reduce medicines\n' +
        'B) Better sugar control\n' +
        'C) Weight loss\n' +
        'D) Complication prevention\n' +
        'E) All of the above'
    });
    return;
  }

  if (s.step === 'p_goal') {
    s.data.main_goal = text;
    await sock.sendMessage(s.jid, {
      text:
        'Based on your details, I’ll personally review your case and suggest the best plan 👩‍⚕️\n\n' +
        'Choose an option below 👇\n\n' +
        `🔹 Book 1:1 Call with Dr. Ruchita Mehta\n${PATIENT_LINK}\n\n` +
        'OR\n\n' +
        `🔹 Join FREE Diabetes Management Webinar\n${DIABETES_WEBINAR_LINK}`
    });
    await finishFlow(sock, sheets, s);
    return;
  }

  if (s.step === 't1_answers') {
    const bulk = parseBulk(text, [
      'type1_since_diagnosed',
      'type1_latest_values',
      'type1_high_low',
      'type1_symptoms'
    ]);
    if (!bulk) {
      await sock.sendMessage(s.jid, {
        text:
          'Please send these 4 details in new lines:\n' +
          '1) Since how many years diagnosed\n' +
          '2) Latest Fasting & PP sugar values\n' +
          '3) Frequent highs/lows\n' +
          '4) Symptoms'
      });
      return;
    }
    Object.assign(s.data, bulk);

    await sock.sendMessage(s.jid, {
      text:
        'Thank you for sharing 🙏\n' +
        'Based on your details, your sugars are currently not very stable, which is common in Type 1 when nutrition timing and lifestyle are not optimized.\n\n' +
        'My approach focuses on:\n' +
        '✔️ Reducing sugar spikes\n' +
        '✔️ Improving insulin response\n' +
        '✔️ Preventing complications\n' +
        '✔️ Improving daily energy\n\n' +
        'Would you like to know how we work step by step? 🙂\nType (Yes or No)'
    });
    s.step = 't1_step';
    return;
  }

  if (s.step === 't1_step') {
    const ans = yesNo(text);
    if (!ans) {
      await sock.sendMessage(s.jid, { text: 'Type Yes or No' });
      return;
    }

    if (ans === 'No') {
      await finishFlow(sock, sheets, s);
      return;
    }

    s.step = 't1_focus';
    await sock.sendMessage(s.jid, {
      text:
        'Before I share details, I just want to understand your goal 🙂\n\n' +
        'What is your main focus right now?\n' +
        'A️⃣ Better sugar control\n' +
        'B️⃣ Reduce fluctuations\n' +
        'C️⃣ Improve energy\n' +
        'D️⃣ Prevent complications\n' +
        'E️⃣ All of the above'
    });
    return;
  }

  if (s.step === 't1_focus') {
    s.data.main_goal = text;
    await sock.sendMessage(s.jid, {
      text:
        'Based on your goal, I recommend a personalized consultation where we deeply analyse your case and create a structured plan.\n\n' +
        'You can book your appointment here 👇\n\n' +
        `🔗${TYPE1_LINK}\n\n` +
        'Let us know once booked, we’ll guide you with the next steps 💙'
    });
    await finishFlow(sock, sheets, s);
  }
}

async function handleOtherFlow(sock, sheets, s, text) {
  if (s.step === 'o_collect') {
    const bulk = parseBulk(text, [
      'name',
      'age',
      'email',
      'current_medication',
      'contact_number',
      'other_concern',
      'other_since'
    ]);
    if (!bulk) {
      await sock.sendMessage(s.jid, {
        text:
          'Please send details in 7 lines:\nName\nAge\nEmail\nCurrent Medication\nContact Number\nConcern\nSince how long'
      });
      return;
    }
    Object.assign(s.data, bulk);
    await sock.sendMessage(s.jid, {
      text:
        'Thank you for sharing 🙏\n\n' +
        'For personalised guidance and a detailed plan, we recommend booking a 1:1 consultation with Dr. Ruchita Mehta 👩‍⚕️✨\n\n' +
        'In the session, you’ll receive:\n' +
        '✔️ Detailed health assessment\n' +
        '✔️ Diet & lifestyle strategy\n' +
        '✔️ Root-cause based plan\n' +
        '✔️ Report analysis\n\n' +
        `You can book your appointment here 👇\n🔗 ${OTHER_LINK}\n\n` +
        'Let us know once booked, we’ll guide you with the next steps 💙'
    });
    await finishFlow(sock, sheets, s);
  }
}

async function handleStudentFlow(sock, sheets, s, text) {
  if (s.step === 's_collect') {
    const bulk = parseBulk(text, ['name', 'age', 'email', 'contact_number']);
    if (!bulk) {
      await sock.sendMessage(s.jid, {
        text: 'Please send details in 4 lines:\nName\nAge\nEmail\nWhatsApp Number'
      });
      return;
    }
    Object.assign(s.data, bulk);
    await sock.sendMessage(s.jid, { text: confirmStudent(s.data) });
    s.step = 's_confirm';
    return;
  }

  if (s.step === 's_confirm') {
    const ans = yesNo(text);
    if (!ans) {
      await sock.sendMessage(s.jid, { text: 'Is this correct? (Yes/No)' });
      return;
    }
    if (ans === 'No') {
      s.step = 's_collect';
      await sock.sendMessage(s.jid, { text: 'Please re-send your 4 details in new lines.' });
      return;
    }
    s.step = 's_best';
    await sock.sendMessage(s.jid, {
      text:
        'Great  Which best describes you?\n\n' +
        'A) Beginner – No diabetes coaching experience\n' +
        'B) Some experience but not confident\n' +
        'C) Already seeing diabetes clients\n' +
        'D) Just exploring'
    });
    return;
  }

  if (s.step === 's_best') {
    s.data.best_describes = text;
    s.step = 's_goal';
    await sock.sendMessage(s.jid, {
      text:
        'What is your main goal from this training?\n\n' +
        'A) Become Diabetes Educator\n' +
        'B) Start own practice\n' +
        'C) Increase income\n' +
        'D) Help more patients\n' +
        'E) All of the above'
    });
    return;
  }

  if (s.step === 's_goal') {
    s.data.training_goal = text;
    s.step = 's_webinar';
    await sock.sendMessage(s.jid, {
      text:
        'Amazing  I am hosting a Free Live Webinar where I will reveal:\n\n' +
        'The 5 Biggest Gaps – Why you are not getting best results in diabetes cases\n' +
        'The 3D Method I personally use for sugar control\n' +
        'Why sugar is not dropping even after diet & medicines\n\n' +
        'How to start getting consistent results in your diabetes clients\n' +
        'Would you like to attend this webinar?\n\n' +
        'Reply YES to get details.'
    });
    return;
  }

  if (s.step === 's_webinar') {
    const ans = yesNo(text);
    if (!ans || ans === 'No') {
      await sock.sendMessage(s.jid, { text: 'Reply YES to get details.' });
      return;
    }
    s.data.webinar_interest = 'Yes';
    await sock.sendMessage(s.jid, { text: `Here's your webinar link:\n${WEBINAR_LINK}` });
    await finishFlow(sock, sheets, s);
  }
}

async function processIncoming(sock, sheets, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter')) {
    return;
  }

  let s = sessions.get(jid);
  if (!s) {
    const existing = await isExistingUser(sheets, canonicalPhone(getPhoneFromJid(jid)));
    if (existing) {
      const textForAi = getIncomingText(msg) || 'Hi';
      const reply = await generateAiReply(textForAi);
      await sock.sendMessage(jid, { text: reply });
      return;
    }
    s = newSession(jid);
    await sock.sendMessage(jid, { text: entryMessage() });
    return;
  }

  const text = getIncomingText(msg);
  if (!text) {
    await sock.sendMessage(jid, { text: 'Please send a text message to continue.' });
    return;
  }

  if (s.step === 'choose') {
    await handleChoice(sock, s, text);
    return;
  }

  if (s.flow === 'patient') {
    await handlePatientFlow(sock, sheets, s, text);
    return;
  }

  if (s.flow === 'other') {
    await handleOtherFlow(sock, sheets, s, text);
    return;
  }

  if (s.flow === 'student') {
    await handleStudentFlow(sock, sheets, s, text);
    return;
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();
  const sheets = buildSheetsClient();

  if (!sheets) {
    logger.warn('google sheets disabled (check GOOGLE_SHEET_ID and service account env)');
  } else {
    logger.info('google sheets enabled');
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    shouldIgnoreJid: (jid) => {
      if (!jid) return true;
      return jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter');
    }
  });

  // Add randomized anti-spam delay to all outgoing replies.
  const rawSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options) => {
    const delayMs = randomDelayMs();
    if (delayMs > 0) {
      logger.info({ jid, delayMs }, 'delaying outgoing message');
      await sleep(delayMs);
    }
    return rawSendMessage(jid, content, options);
  };

  sock.ev.on('creds.update', saveCreds);

  // Headless logs often render QR poorly; pairing code is more reliable on Railway.
  if (USE_PAIRING_CODE && !state.creds.registered && PAIRING_PHONE_NUMBER) {
    setTimeout(async () => {
      try {
        const pairingCode = await sock.requestPairingCode(PAIRING_PHONE_NUMBER);
        logger.info(
          { pairingCode },
          'pairing code generated (WhatsApp > Linked devices > Link with phone number)'
        );
      } catch (err) {
        logger.error({ err }, 'failed to generate pairing code');
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !USE_PAIRING_CODE) {
      qrcode.generate(qr, { small: false });
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(
        qr
      )}`;
      logger.info({ qrUrl }, 'open this URL to scan QR if terminal QR looks broken');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ statusCode, shouldReconnect }, 'connection closed');
      if (shouldReconnect) start();
    } else if (connection === 'open') {
      logger.info('connection opened');
    }
  });

  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify' && event.type !== 'append') return;
    for (const msg of event.messages) {
      try {
        logger.info(
          {
            eventType: event.type,
            jid: msg.key?.remoteJid,
            fromMe: msg.key?.fromMe,
            hasMessage: Boolean(msg.message),
            extractedText: getIncomingText(msg)
          },
          'incoming message'
        );
        await processIncoming(sock, sheets, msg);
      } catch (err) {
        logger.error({ err, jid: msg.key?.remoteJid }, 'failed to process incoming message');
      }
    }
  });
}

start().catch((err) => {
  logger.error({ err }, 'fatal error');
  process.exit(1);
});

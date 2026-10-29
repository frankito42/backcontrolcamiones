import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const soundDir = path.resolve(currentDir, '../../sonido');
const dataDir = path.join(soundDir, 'data');
const audioDir = path.join(dataDir, 'audio');
const callFile = path.join(dataDir, 'llamado.json');
const voices = [
  { id: 'nova', label: 'Nova (mujer)' },
  { id: 'shimmer', label: 'Shimmer (mujer)' },
  { id: 'alloy', label: 'Alloy (neutra)' },
  { id: 'echo', label: 'Echo (hombre)' },
  { id: 'fable', label: 'Fable (neutra)' },
  { id: 'onyx', label: 'Onyx (hombre)' },
];

let writeQueue = Promise.resolve();

function jsonError(res, error, status) {
  return res.status(status).set('Cache-Control', 'no-store').json({ ok: false, error });
}

async function readCall() {
  try {
    const data = JSON.parse(await fs.readFile(callFile, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function saveCall(name) {
  let saved;
  const write = writeQueue.catch(() => {}).then(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const current = await readCall();
    saved = { id: Number(current?.id || 0) + 1, nombre: name, created_at: new Date().toISOString() };
    const tempFile = `${callFile}.${process.pid}.tmp`;
    await fs.writeFile(tempFile, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8' });
    await fs.rename(tempFile, callFile);
  });
  writeQueue = write;
  return write.then(() => saved);
}

async function announce(req, res) {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST, OPTIONS');
    return jsonError(res, 'Usá POST', 405);
  }
  const name = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
  if (!name) return jsonError(res, 'Falta el campo nombre', 400);
  try {
    return res.set('Cache-Control', 'no-store').json({ ok: true, llamado: await saveCall(name) });
  } catch (error) {
    console.error(error);
    return jsonError(res, 'No se pudo guardar el llamado', 500);
  }
}

async function actual(req, res) {
  if (req.method !== 'GET') {
    res.set('Allow', 'GET, OPTIONS');
    return jsonError(res, 'Usá GET', 405);
  }
  return res.set('Cache-Control', 'no-store').json({ ok: true, llamado: await readCall() });
}

function cloudEnabled() {
  return process.env.TTS_CLOUD_ENABLED === 'true' && Boolean(process.env.TTS_OPENAI_API_KEY);
}

function options(req, res) {
  if (req.method !== 'GET') {
    res.set('Allow', 'GET, OPTIONS');
    return jsonError(res, 'Usá GET', 405);
  }
  return res.set('Cache-Control', 'no-store').json({
    ok: true,
    cloud: {
      enabled: cloudEnabled(),
      default_voice: process.env.TTS_OPENAI_VOICE || 'nova',
      voices,
    },
  });
}

async function synthesize(req, res) {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST, OPTIONS');
    return jsonError(res, 'Usá POST', 405);
  }
  if (!cloudEnabled()) return jsonError(res, 'Cloud TTS deshabilitado. Configurá TTS_CLOUD_ENABLED y TTS_OPENAI_API_KEY en .env.', 503);
  let text = typeof req.body.texto === 'string' ? req.body.texto.trim() : '';
  if (!text) return jsonError(res, 'Falta el campo texto', 400);
  text = Array.from(text).slice(0, 400).join('');
  const voiceIds = voices.map((voice) => voice.id);
  const voice = voiceIds.includes(req.body.voice) ? req.body.voice : (process.env.TTS_OPENAI_VOICE || 'nova');
  const model = process.env.TTS_OPENAI_MODEL || 'tts-1';
  const hash = crypto.createHash('sha256').update(`${model}|${voice}|${text}`).digest('hex');
  const audioPath = path.join(audioDir, `${hash}.mp3`);
  try {
    await fs.mkdir(audioDir, { recursive: true });
    try {
      const stat = await fs.stat(audioPath);
      if (stat.size > 0) return res.set('Cache-Control', 'private, max-age=86400').type('audio/mpeg').sendFile(audioPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TTS_OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      return jsonError(res, `OpenAI TTS falló (HTTP ${response.status}): ${detail}`, 502);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(audioPath, audio, { flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return res.set('Cache-Control', 'private, max-age=86400').type('audio/mpeg').sendFile(audioPath);
  } catch (error) {
    console.error(error);
    return jsonError(res, error.name === 'TimeoutError' ? 'OpenAI TTS agotó el tiempo de espera.' : 'No se pudo sintetizar el audio.', 502);
  }
}

async function check(req, res) {
  await Promise.all([fs.mkdir(dataDir, { recursive: true }), fs.mkdir(audioDir, { recursive: true })]);
  let writable = false;
  try {
    const testFile = path.join(dataDir, `._write-test-${process.pid}`);
    await fs.writeFile(testFile, 'ok');
    await fs.unlink(testFile);
    writable = true;
  } catch {
    writable = false;
  }
  const status = writable ? 200 : 503;
  return res.status(status).type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagnóstico TTS</title><body><h1>Diagnóstico TTS</h1><ul><li>Node.js: ${process.version}</li><li>/data escribible: ${writable ? 'OK' : 'NO'}</li><li>/data/audio escribible: ${writable ? 'OK' : 'NO'}</li><li>Cloud TTS: ${cloudEnabled() ? `configurado (${process.env.TTS_OPENAI_VOICE || 'nova'})` : 'deshabilitado (se usa Web Speech)'}</li></ul><p><a href="/sonido/pantalla">Abrir pantalla TTS</a></p></body></html>`);
}

export function registerSoundRoutes(app) {
  app.all('/api/sound/announce', (req, res, next) => announce(req, res).catch(next));
  app.all('/api/sound/current', (req, res, next) => actual(req, res).catch(next));
  app.all('/api/sound/options', options);
  app.all('/api/sound/synthesize', (req, res, next) => synthesize(req, res).catch(next));
  app.get(['/sonido', '/sonido/'], (_req, res) => res.redirect(302, '/sonido/pantalla'));
  app.get('/sonido/pantalla', (_req, res) => res.type('html').sendFile(path.join(soundDir, 'pantalla.html')));
  app.get('/sonido/check', (req, res, next) => check(req, res).catch(next));
  app.use('/sonido/assets', express.static(path.join(soundDir, 'assets')));
}
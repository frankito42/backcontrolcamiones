import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerRoutes } from '../src/routes.js';

test('los endpoints Node usan rutas limpias y no dependen de PHP ni de DB para páginas públicas', async (context) => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${baseUrl}/api/auth/login`);
  assert.equal(login.status, 405);
  assert.equal((await login.json()).success, false);

  const board = await fetch(`${baseUrl}/turnos/en-curso`);
  assert.equal(board.status, 200);
  const boardHtml = await board.text();
  assert.match(boardHtml, /Turnos en curso/);
  assert.match(boardHtml, /socket\.io\/socket\.io\.js/);
  assert.match(boardHtml, /turnos\.changed/);

  const screen = await fetch(`${baseUrl}/sonido/pantalla`);
  assert.equal(screen.status, 200);
  assert.match(await screen.text(), /assets\/pantalla\.js/);

  const options = await fetch(`${baseUrl}/api/sound/options`);
  assert.equal(options.status, 200);
  const soundOptions = await options.json();
  assert.equal(soundOptions.ok, true);
  assert.equal(soundOptions.cloud.voices.length, 6);

  const call = await fetch(`${baseUrl}/api/llamar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(call.status, 400);
  assert.equal((await call.json()).detail, 'Se requiere numero y patente.');

  const oldPhpEndpoint = await fetch(`${baseUrl}/backend/login.php`);
  assert.equal(oldPhpEndpoint.status, 404);
});
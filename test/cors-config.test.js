import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import {
  createCorsOriginCallback,
  parseCorsOrigins,
} from '../src/cors-config.js';

function startCorsApp(context, configuredOrigins) {
  const app = express();
  app.use(cors({
    origin: createCorsOriginCallback(configuredOrigins),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return new Promise((resolve) => {
    server.once('listening', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test('CORS permite una lista de dominios exactos y normaliza barra final', () => {
  assert.deepEqual(
    [...parseCorsOrigins('https://app.example.com/, https://admin.example.com')],
    ['https://app.example.com', 'https://admin.example.com'],
  );
  assert.equal(parseCorsOrigins(''), null);
  assert.equal(parseCorsOrigins('*'), null);
});

test('CORS rechaza rutas y protocolos distintos de HTTP(S) en la configuración', () => {
  assert.throws(
    () => parseCorsOrigins('https://app.example.com/dashboard'),
    /solo orígenes/,
  );
  assert.throws(
    () => parseCorsOrigins('ftp://app.example.com'),
    /solo orígenes/,
  );
});

test('preflight refleja origen permitido y no concede acceso a otro dominio', async (context) => {
  const baseUrl = await startCorsApp(
    context,
    'https://app.example.com,https://admin.example.com',
  );
  const preflight = await fetch(`${baseUrl}/api/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });

  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get('access-control-allow-origin'),
    'https://app.example.com',
  );
  assert.match(
    preflight.headers.get('access-control-allow-headers') || '',
    /authorization/i,
  );

  const rejected = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'https://not-allowed.example.com' },
  });
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

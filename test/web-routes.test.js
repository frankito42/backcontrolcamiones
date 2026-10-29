import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import { pool } from '../src/db.js';
import { registerWebRoutes } from '../src/web-routes.js';

function startApp(context) {
  const app = express();
  registerWebRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return new Promise((resolve) => {
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('la página muestra los catálogos y permite descargar Excel sin datos sensibles', async (context) => {
  context.mock.method(pool, 'query', async (query) => {
    if (query.includes('FROM usuarios u')) {
      return {
        rows: [{
          nombre: '<Admin>',
          usuario: 'admin',
          rol: 'admin',
          zona: null,
          destino: 'Central',
          pass: 'no-debe-aparecer',
          dni: 'no-debe-aparecer',
          telefono: 'no-debe-aparecer',
        }],
      };
    }
    if (query.includes('FROM roles')) {
      return { rows: [{ slug: 'admin', nombre: 'Administrador', activo: true }] };
    }
    if (query.includes('FROM zonas')) return { rows: [{ nombre: 'Defiba' }] };
    if (query.includes('FROM destinos')) return { rows: [{ nombre: 'Central' }] };
    throw new Error(`Unexpected query: ${query}`);
  });
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/configuracion/usuarios`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(html, /SICOF · Usuarios y configuración/);
  assert.match(html, /&lt;Admin&gt;/);
  assert.match(html, /Administrador/);
  assert.match(html, /Defiba/);
  assert.match(html, /Central/);
  assert.match(html, /window\.print\(\)/);
  assert.match(html, /\/configuracion\/usuarios\.xlsx/);
  assert.doesNotMatch(html, /no-debe-aparecer/);
  assert.doesNotMatch(html, /<Admin>/);

  const excelResponse = await fetch(`${baseUrl}/configuracion/usuarios.xlsx`);
  const contentDisposition = excelResponse.headers.get('content-disposition');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await excelResponse.arrayBuffer()));
  const exportedValues = workbook.worksheets
    .flatMap((sheet) => sheet.getSheetValues().flat())
    .filter((value) => value != null)
    .join(' ');

  assert.equal(excelResponse.status, 200);
  assert.match(excelResponse.headers.get('content-type'), /spreadsheetml\.sheet/);
  assert.match(contentDisposition, /SICOF-usuarios-roles-zonas-destinos\.xlsx/);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Usuarios', 'Roles', 'Zonas', 'Destinos']);
  assert.match(exportedValues, /<Admin>/);
  assert.match(exportedValues, /Administrador/);
  assert.match(exportedValues, /Defiba/);
  assert.match(exportedValues, /Central/);
  assert.doesNotMatch(exportedValues, /no-debe-aparecer/);
});

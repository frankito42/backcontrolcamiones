import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(currentDir, '../.env') });

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
if (credentialsPath && !path.isAbsolute(credentialsPath)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(
    currentDir,
    '..',
    credentialsPath,
  );
}
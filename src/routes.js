import { registerAccountRoutes } from './account-routes.js';
import { registerCargasEspecialesRoutes } from './cargas-especiales-routes.js';
import { registerPaseLibreRoutes } from './pase-libre-routes.js';
import { registerChatRoutes } from './chat-routes.js';
import { registerCallBridgeRoutes } from './call-bridge-routes.js';
import { registerQrRoutes } from './qr-routes.js';
import { registerSoundRoutes } from './sound-routes.js';
import { registerTurnoRoutes } from './turno-routes.js';
import { registerWebRoutes } from './web-routes.js';
import { registerPushNotificationRoutes } from './push-notifications.js';

export function registerRoutes(app) {
  registerAccountRoutes(app);
  registerCargasEspecialesRoutes(app);
  registerPaseLibreRoutes(app);
  registerChatRoutes(app);
  registerCallBridgeRoutes(app);
  registerTurnoRoutes(app);
  registerQrRoutes(app);
  registerSoundRoutes(app);
  registerPushNotificationRoutes(app);
  registerWebRoutes(app);
}
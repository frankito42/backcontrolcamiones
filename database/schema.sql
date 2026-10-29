CREATE TABLE IF NOT EXISTS zonas (
  id INT NOT NULL AUTO_INCREMENT,
  nombre VARCHAR(80) NOT NULL,
  logo_url VARCHAR(500) NULL,
  creado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_zonas_nombre (nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS destinos (
  id INT NOT NULL AUTO_INCREMENT,
  nombre VARCHAR(120) NOT NULL,
  creado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_destinos_nombre (nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
  id INT NOT NULL AUTO_INCREMENT,
  slug VARCHAR(30) NOT NULL,
  nombre VARCHAR(80) NOT NULL,
  logo_url VARCHAR(500) NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  creado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS usuarios (
  id INT NOT NULL AUTO_INCREMENT,
  nombre VARCHAR(120) NOT NULL,
  `user` VARCHAR(60) NOT NULL,
  dni VARCHAR(20) NOT NULL,
  telefono VARCHAR(30) NULL,
  zona VARCHAR(80) NULL,
  destino_id INT NULL,
  pass VARCHAR(120) NOT NULL,
  rol VARCHAR(30) NOT NULL DEFAULT 'operador',
  logo_url VARCHAR(500) NULL,
  fondo_url VARCHAR(500) NULL,
  tema_preferido VARCHAR(30) NOT NULL DEFAULT 'oscuro',
  activo TINYINT(1) NOT NULL DEFAULT 1,
  creado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_usuarios_user (`user`),
  KEY idx_usuarios_destino (destino_id),
  CONSTRAINT fk_usuarios_destino FOREIGN KEY (destino_id)
    REFERENCES destinos(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_usuarios_rol CHECK (rol IN ('admin', 'admin_aduana', 'admin_defiba', 'admin_transito', 'operador', 'pase', 'defiba', 'aduana')),
  CONSTRAINT chk_usuarios_tema CHECK (tema_preferido IN ('oscuro', 'claro', 'azul_marino', 'azul_claro'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pase_libre_estado (
  id SMALLINT NOT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 0,
  actualizado_por INT NULL,
  actualizado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_pase_libre_estado_id CHECK (id = 1),
  CONSTRAINT fk_pase_libre_estado_usuario FOREIGN KEY (actualizado_por)
    REFERENCES usuarios(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO pase_libre_estado (id, activo) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS camioneros (
  id INT NOT NULL AUTO_INCREMENT,
  nombre VARCHAR(120) NOT NULL,
  dni VARCHAR(20) NOT NULL,
  patente VARCHAR(20) NOT NULL,
  telefono VARCHAR(30) NULL,
  creado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_camioneros_dni (dni),
  KEY idx_camioneros_patente (patente)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS turnos (
  id INT NOT NULL AUTO_INCREMENT,
  numero INT NULL,
  camionero_id INT NOT NULL,
  patente VARCHAR(20) NOT NULL,
  empresa VARCHAR(120) NULL,
  mercaderia TEXT NULL,
  mercaderia_vacia TINYINT(1) NOT NULL DEFAULT 0,
  fecha_ingreso DATE NOT NULL DEFAULT (CURRENT_DATE),
  hora_ingreso TIME NOT NULL DEFAULT (CURRENT_TIME),
  estado VARCHAR(30) NOT NULL DEFAULT 'pendiente',
  origen VARCHAR(20) NOT NULL DEFAULT 'normal',
  numero_operacion VARCHAR(80) NULL,
  prioridad VARCHAR(20) NULL,
  usuario_id INT NULL,
  usuario_pase_id INT NULL,
  zona_id INT NOT NULL,
  destino_id INT NULL,
  aduana_confirmado TINYINT(1) NOT NULL DEFAULT 0,
  aduana_confirmado_en DATETIME(3) NULL,
  estado_aduana VARCHAR(20) NULL,
  defiba_aviso_confirmado TINYINT(1) NOT NULL DEFAULT 0,
  operador_aduana_aviso_confirmado TINYINT(1) NOT NULL DEFAULT 0,
  bocina_pendiente TINYINT(1) NOT NULL DEFAULT 0,
  bocina_pendiente_en DATETIME(3) NULL,
  bocina_procesando TINYINT(1) NOT NULL DEFAULT 0,
  bocina_reclamada_en DATETIME(3) NULL,
  creada_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_turnos_zona_numero (zona_id, numero),
  KEY idx_turnos_patente (patente),
  KEY idx_turnos_camionero_estado (camionero_id, estado),
  KEY idx_turnos_estado_fecha (estado, fecha_ingreso, hora_ingreso),
  KEY idx_turnos_zona_estado_fecha (zona_id, estado, fecha_ingreso, hora_ingreso),
  KEY idx_turnos_estado_numero (estado, numero),
  KEY idx_turnos_numero (numero),
  KEY idx_turnos_bocina_queue (bocina_pendiente, bocina_procesando, aduana_confirmado, estado, bocina_pendiente_en, id),
  CONSTRAINT fk_turnos_camionero FOREIGN KEY (camionero_id)
    REFERENCES camioneros(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_turnos_usuario FOREIGN KEY (usuario_id)
    REFERENCES usuarios(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_turnos_usuario_pase FOREIGN KEY (usuario_pase_id)
    REFERENCES usuarios(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_turnos_zona FOREIGN KEY (zona_id)
    REFERENCES zonas(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_turnos_destino FOREIGN KEY (destino_id)
    REFERENCES destinos(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_turnos_estado CHECK (estado IN ('pendiente', 'en_curso', 'finalizado', 'reservado', 'listo_para_salir', 'anulado'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS turno_historial (
  id BIGINT NOT NULL AUTO_INCREMENT,
  turno_id INT NOT NULL,
  zona_id INT NOT NULL,
  estado VARCHAR(30) NOT NULL,
  evento VARCHAR(30) NOT NULL DEFAULT 'estado',
  usuario_id INT NULL,
  origen VARCHAR(30) NOT NULL DEFAULT 'sistema',
  registrado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_historial_turno_fecha (turno_id, registrado_en),
  KEY idx_historial_zona_estado (zona_id, estado, registrado_en),
  KEY idx_historial_evento_turno (evento, turno_id),
  CONSTRAINT fk_historial_turno FOREIGN KEY (turno_id)
    REFERENCES turnos(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_historial_zona FOREIGN KEY (zona_id)
    REFERENCES zonas(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_historial_usuario FOREIGN KEY (usuario_id)
    REFERENCES usuarios(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_historial_estado CHECK (estado IN ('pendiente', 'en_curso', 'finalizado', 'reservado', 'listo_para_salir', 'anulado'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cargas_especiales (
  id INT NOT NULL AUTO_INCREMENT,
  patente VARCHAR(20) NOT NULL,
  zona_id INT NOT NULL,
  destino_id INT NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'en_camino',
  usuario_id INT NULL,
  creada_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_cargas_especiales_zona_estado_fecha (zona_id, estado, creada_en),
  CONSTRAINT fk_cargas_especiales_zona FOREIGN KEY (zona_id)
    REFERENCES zonas(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_cargas_especiales_destino FOREIGN KEY (destino_id)
    REFERENCES destinos(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_cargas_especiales_usuario FOREIGN KEY (usuario_id)
    REFERENCES usuarios(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_cargas_especiales_estado CHECK (estado IN ('en_camino', 'finalizado'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS qr_tokens (
  token CHAR(32) NOT NULL,
  zona_id INT NOT NULL,
  expires_at BIGINT NOT NULL,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_at DATETIME(3) NULL,
  used_at DATETIME(3) NULL,
  PRIMARY KEY (token),
  KEY idx_qr_tokens_zona (zona_id),
  CONSTRAINT fk_qr_tokens_zona FOREIGN KEY (zona_id)
    REFERENCES zonas(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_sessions (
  token_hash CHAR(64) NOT NULL,
  usuario_id INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (token_hash),
  KEY idx_chat_sessions_user (usuario_id, expires_at),
  CONSTRAINT fk_chat_sessions_usuario FOREIGN KEY (usuario_id)
    REFERENCES usuarios(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT NOT NULL AUTO_INCREMENT,
  sender_id INT NOT NULL,
  recipient_id INT NOT NULL,
  content VARCHAR(2000) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  read_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_chat_messages_conversation (sender_id, recipient_id, id DESC),
  KEY idx_chat_messages_unread (recipient_id, sender_id, read_at, id DESC),
  CONSTRAINT fk_chat_messages_sender FOREIGN KEY (sender_id)
    REFERENCES usuarios(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_chat_messages_recipient FOREIGN KEY (recipient_id)
    REFERENCES usuarios(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_chat_messages_content CHECK (CHAR_LENGTH(TRIM(content)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
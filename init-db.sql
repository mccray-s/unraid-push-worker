-- 1. Devices Table
CREATE TABLE IF NOT EXISTS devices (
    deck_id TEXT PRIMARY KEY,
    device_token TEXT NOT NULL,
    is_enabled BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Servers Table
CREATE TABLE IF NOT EXISTS servers (
    server_id TEXT PRIMARY KEY,
    webhook_token TEXT NOT NULL UNIQUE,
    message_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_token ON servers(webhook_token);

-- 3. Subscriptions (Many-to-Many Mapping)
CREATE TABLE IF NOT EXISTS server_subscriptions (
    server_id TEXT NOT NULL,
    deck_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, deck_id),
    FOREIGN KEY(deck_id) REFERENCES devices(deck_id) ON DELETE CASCADE,
    FOREIGN KEY(server_id) REFERENCES servers(server_id) ON DELETE CASCADE
);

-- 4. Global Message Stats
CREATE TABLE IF NOT EXISTS message_stats (
    date TEXT PRIMARY KEY,
    message_count INTEGER DEFAULT 0
);

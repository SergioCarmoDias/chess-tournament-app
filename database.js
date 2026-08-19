const Database = require('better-sqlite3');
const db = new Database('tournament.db');

// Enable foreign key enforcement
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    points REAL DEFAULT 0,
    buchholz REAL DEFAULT 0,
    sonneborn_berger REAL DEFAULT 0,
    has_bye INTEGER DEFAULT 0,
    batch TEXT DEFAULT NULL,            -- 'A', 'B', or NULL
    stage_2_qualified INTEGER DEFAULT 0,  -- 1 if qualified for Stage 2
    stage_2_points REAL DEFAULT 0.0
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_number INTEGER NOT NULL,
    board_number INTEGER DEFAULT NULL,
    white_id INTEGER,
    black_id INTEGER,
    result TEXT DEFAULT 'PENDING',      -- '1-0', '0-1', '0.5-0.5', 'ABORTED', 'PENDING'
    winner_id INTEGER,
    is_bye INTEGER DEFAULT 0,
    stage TEXT DEFAULT 'STAGE_1',
    batch TEXT DEFAULT NULL,            -- 'A', 'B', or NULL
    FOREIGN KEY(white_id) REFERENCES players(id),
    FOREIGN KEY(black_id) REFERENCES players(id),
    FOREIGN KEY(winner_id) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Set default fallback settings if not configured
const existingType = db.prepare("SELECT value FROM settings WHERE key = 'tournament_type'").get();
if (!existingType) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('tournament_type', 'SWISS')").run();
}

const existingBoards = db.prepare("SELECT value FROM settings WHERE key = 'board_count'").get();
if (!existingBoards) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('board_count', '4')").run();
}

const existingMaxRounds = db.prepare("SELECT value FROM settings WHERE key = 'max_rounds'").get();
if (!existingMaxRounds) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('max_rounds', '5')").run();
}

module.exports = db;
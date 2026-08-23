const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const csv = require('csv-parser');
const db = require('./database');

const app = express();

// Enable foreign key enforcement in SQLite
db.pragma('foreign_keys = ON');

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure upload directory for Multer
const upload = multer({ dest: 'uploads/' });

// In-memory or database storage for tournament winners
let tournamentWinners = {
  winner: null,
  runnerUp: null,
  finalizedAt: null
};

// ==========================================
// CONFIGURATION & HELPER FUNCTIONS
// ==========================================

// Explicitly define Batch A player IDs (Optional)
const EXPLICIT_BATCH_A_IDS = []; 

function updateAllTieBreaks() {
  db.transaction(() => {
    // 1. Recalculate basic tournament points (including STAGE_1, STAGE_2, and PLAYOFFS)
    db.prepare(`
      UPDATE players 
      SET points = (
        SELECT COALESCE(SUM(
          CASE 
            WHEN m.white_id = players.id AND m.result = '1-0' THEN 1.0
            WHEN m.black_id = players.id AND m.result = '0-1' THEN 1.0
            WHEN m.result = '0.5-0.5' THEN 0.5
            WHEN m.is_bye = 1 AND m.white_id = players.id THEN 1.0
            ELSE 0.0
          END
        ), 0)
        FROM matches m
        WHERE (m.white_id = players.id OR m.black_id = players.id)
          AND m.result NOT IN ('PENDING', 'ABORTED')
      )
    `).run();

    // 2. Recalculate stage_2_points exclusively from STAGE_2 matches
    db.prepare(`
      UPDATE players 
      SET stage_2_points = (
        SELECT COALESCE(SUM(
          CASE 
            WHEN m.white_id = players.id AND m.result = '1-0' THEN 1.0
            WHEN m.black_id = players.id AND m.result = '0-1' THEN 1.0
            WHEN m.result = '0.5-0.5' THEN 0.5
            ELSE 0.0
          END
        ), 0)
        FROM matches m
        WHERE m.stage = 'STAGE_2'
          AND (m.white_id = players.id OR m.black_id = players.id)
          AND m.result NOT IN ('PENDING', 'ABORTED')
      )
    `).run();

    // 3. Compute Buchholz & Sonneborn-Berger Tie-Breaks
    const players = db.prepare('SELECT id FROM players').all();
    const updateTieBreaksStmt = db.prepare('UPDATE players SET buchholz = ?, sonneborn_berger = ? WHERE id = ?');
    const getMatchesStmt = db.prepare(`
      SELECT white_id, black_id, result, is_bye
      FROM matches 
      WHERE (white_id = ? OR black_id = ?) 
        AND result NOT IN ('PENDING', 'ABORTED')
    `);
    const getPointsStmt = db.prepare('SELECT points FROM players WHERE id = ?');

    for (const player of players) {
      const matches = getMatchesStmt.all(player.id, player.id);

      let buchholzScore = 0;
      let sbScore = 0;

      for (const m of matches) {
        if (m.is_bye === 1) continue;

        const opponentId = (m.white_id === player.id) ? m.black_id : m.white_id;
        if (!opponentId) continue;

        const opponent = getPointsStmt.get(opponentId);
        const oppPoints = opponent ? opponent.points : 0;

        buchholzScore += oppPoints;

        const isWhite = (m.white_id === player.id);
        const won = (isWhite && m.result === '1-0') || (!isWhite && m.result === '0-1');
        const drawn = (m.result === '0.5-0.5');

        if (won) {
          sbScore += oppPoints;
        } else if (drawn) {
          sbScore += (oppPoints * 0.5);
        }
      }

      updateTieBreaksStmt.run(buchholzScore, sbScore, player.id);
    }
  })();
}

function havePlayed(p1Id, p2Id) {
  const match = db.prepare(`
    SELECT id FROM matches 
    WHERE (white_id = ? AND black_id = ?) 
       OR (white_id = ? AND black_id = ?)
  `).get(p1Id, p2Id, p2Id, p1Id);
  return !!match;
}

function generateRoundRobinPairings(players, roundNumber) {
  const pool = [...players];
  if (pool.length % 2 !== 0) {
    pool.push({ id: null, name: 'BYE' });
  }

  const numPlayers = pool.length;
  const totalSingleRounds = numPlayers - 1;
  const isSecondHalf = roundNumber > totalSingleRounds;
  const effectiveRound = isSecondHalf ? ((roundNumber - 1) % totalSingleRounds) + 1 : roundNumber;

  const fixed = pool[0];
  const rest = pool.slice(1);
  const shift = (effectiveRound - 1) % rest.length;
  const rotatedRest = [...rest.slice(rest.length - shift), ...rest.slice(0, rest.length - shift)];
  const currentPool = [fixed, ...rotatedRest];

  const pairings = [];
  for (let i = 0; i < numPlayers / 2; i++) {
    let white = currentPool[i];
    let black = currentPool[numPlayers - 1 - i];

    if (isSecondHalf) {
      const temp = white;
      white = black;
      black = temp;
    }

    if (white.id !== null && black.id !== null) {
      pairings.push({ white, black, isBye: false });
    } else {
      const actualPlayer = white.id !== null ? white : black;
      pairings.push({ white: actualPlayer, black: null, isBye: true });
    }
  }

  return pairings;
}

// True Swiss pairing algorithm that respects score brackets and prevents rematches
function generateSwissPairings(pool) {
  // Sort pool strictly by current standings criteria
  const sorted = [...pool].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if ((b.sonneborn_berger || 0) !== (a.sonneborn_berger || 0)) return (b.sonneborn_berger || 0) - (a.sonneborn_berger || 0);
    if ((b.buchholz || 0) !== (a.buchholz || 0)) return (b.buchholz || 0) - (a.buchholz || 0);
    return (b.manual_rank || 0) - (a.manual_rank || 0);
  });

  const paired = new Set();
  const pairings = [];

  // Recursive backtracking function to find valid Swiss pairings avoiding rematches
  function pairRecursive(index, currentPairings) {
    if (index >= sorted.length) return true;

    const p1 = sorted[index];
    if (paired.has(p1.id)) {
      return pairRecursive(index + 1, currentPairings);
    }

    // Look through remaining unpaired players for a valid opponent
    for (let j = index + 1; j < sorted.length; j++) {
      const p2 = sorted[j];
      if (paired.has(p2.id)) continue;
      if (havePlayed(p1.id, p2.id)) continue; // Skip repeat opponents

      // Try pairing p1 and p2
      paired.add(p1.id);
      paired.add(p2.id);
      currentPairings.push({ white: p1, black: p2 });

      if (pairRecursive(index + 1, currentPairings)) {
        return true;
      }

      // Backtrack if it leads to a dead end later
      currentPairings.pop();
      paired.delete(p2.id);
      paired.delete(p1.id);
    }

    // Fallback: If strict anti-rematch fails due to tight bracket restrictions, relax rematch check for this node
    for (let j = index + 1; j < sorted.length; j++) {
      const p2 = sorted[j];
      if (paired.has(p2.id)) continue;

      paired.add(p1.id);
      paired.add(p2.id);
      currentPairings.push({ white: p1, black: p2 });

      if (pairRecursive(index + 1, currentPairings)) {
        return true;
      }

      currentPairings.pop();
      paired.delete(p2.id);
      paired.delete(p1.id);
    }

    return false;
  }

  pairRecursive(0, pairings);
  return pairings;
}

// ==========================================
// API ROUTES
// ==========================================

app.get('/api/settings', (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings').all();
    const result = {};
    settings.forEach(s => { result[s.key] = s.value; });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const { format, boardCount, maxRounds } = req.body;
    const upsertSetting = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");

    if (format) {
      if (!['SWISS', 'ROUND_ROBIN'].includes(format)) {
        return res.status(400).json({ error: 'Invalid format. Use SWISS or ROUND_ROBIN.' });
      }
      upsertSetting.run('tournament_type', format);
    }
    if (boardCount) {
      const boards = parseInt(boardCount, 10);
      if (isNaN(boards) || boards < 1) {
        return res.status(400).json({ error: 'boardCount must be a positive number.' });
      }
      upsertSetting.run('board_count', boards.toString());
    }
    if (maxRounds) {
      const rounds = parseInt(maxRounds, 10);
      if (isNaN(rounds) || rounds < 1) {
        return res.status(400).json({ error: 'maxRounds must be a positive number.' });
      }
      upsertSetting.run('max_rounds', rounds.toString());
    }

    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/players', (req, res) => {
  try {
    const players = db.prepare('SELECT id, name, points, buchholz, COALESCE(sonneborn_berger, 0) AS sonneborn_berger, COALESCE(manual_rank, 0) AS manual_rank, batch, stage_2_qualified FROM players ORDER BY id ASC').all();
    res.json(players);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/players', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const info = db.prepare('INSERT INTO players (name, points, buchholz, sonneborn_berger, manual_rank) VALUES (?, 0, 0, 0, 0)').run(name.trim());
    res.json({ id: info.lastInsertRowid, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/swap-rank', (req, res) => {
  try {
    const { playerId, targetPlayerId } = req.body;
    if (!playerId || !targetPlayerId) {
      return res.status(400).json({ error: 'Both playerId and targetPlayerId are required.' });
    }

    db.transaction(() => {
      const p1 = db.prepare('SELECT id, manual_rank FROM players WHERE id = ?').get(playerId);
      const p2 = db.prepare('SELECT id, manual_rank FROM players WHERE id = ?').get(targetPlayerId);

      if (!p1 || !p2) {
        throw new Error('One or both players not found.');
      }

      const newRank = (p2.manual_rank || 0) + 1;
      db.prepare('UPDATE players SET manual_rank = ? WHERE id = ?').run(newRank, playerId);
    })();

    res.json({ message: 'Tie-break preference updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/players/:id/batch', (req, res) => {
  try {
    const playerId = req.params.id;
    let { batch } = req.body;

    // Normalize empty strings or undefined to null
    if (!batch || batch.trim() === '') {
      batch = null;
    } else {
      batch = batch.toUpperCase();
      if (!['A', 'B'].includes(batch)) {
        return res.status(400).json({ error: 'Invalid batch. Use A, B, or null.' });
      }
    }

    const result = db.prepare('UPDATE players SET batch = ? WHERE id = ?').run(batch, playerId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Player not found.' });
    }

    res.json({ message: 'Player batch updated successfully.', batch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/import-csv', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }

  const results = [];
  const filePath = req.file.path;

  const cleanupFile = () => {
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore cleanup */ }
    }
  };

  fs.createReadStream(filePath)
    .pipe(csv())
    .on('data', (data) => {
      const playerName = data.name || data.Name || data['Player Name'] || data.player_name || Object.values(data)[0];
      if (playerName && playerName.trim()) {
        results.push(playerName.trim());
      }
    })
    .on('end', () => {
      cleanupFile();

      if (results.length === 0) {
        return res.status(400).json({ error: 'No valid player names found in CSV' });
      }

      try {
        const insertStmt = db.prepare('INSERT INTO players (name, points, buchholz, sonneborn_berger, manual_rank) VALUES (?, 0, 0, 0, 0)');
        let importedCount = 0;

        db.transaction(() => {
          for (const name of results) {
            insertStmt.run(name);
            importedCount++;
          }
        })();
        res.json({ message: `Successfully imported ${importedCount} players.`, count: importedCount });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    })
    .on('error', (err) => {
      cleanupFile();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to process CSV file: ' + err.message });
      }
    });
});

app.post('/api/players/lock-batches', (req, res) => {
  try {
    const players = db.prepare('SELECT id, batch FROM players ORDER BY id ASC').all();

    if (players.length === 0) {
      return res.status(400).json({ error: 'No players registered.' });
    }

    if (players.length <= 9) {
      return res.status(400).json({ 
        error: 'Batches not required. Total players are 9 or fewer.' 
      });
    }

    db.transaction(() => {
      const updateBatchStmt = db.prepare('UPDATE players SET batch = ? WHERE id = ?');

      if (typeof EXPLICIT_BATCH_A_IDS !== 'undefined' && EXPLICIT_BATCH_A_IDS.length > 0) {
        players.forEach(p => {
          const batch = EXPLICIT_BATCH_A_IDS.includes(p.id) ? 'A' : 'B';
          updateBatchStmt.run(batch, p.id);
        });
        return;
      }

      let countA = players.filter(p => p.batch === 'A').length;
      let countB = players.filter(p => p.batch === 'B').length;

      players.forEach((p) => {
        if (!p.batch) {
          let assignedBatch = 'A';
          
          if (countA < 5) {
            assignedBatch = 'A';
            countA++;
          } else if (countB < countA) {
            assignedBatch = 'B';
            countB++;
          } else {
            assignedBatch = 'A';
            countA++;
          }

          updateBatchStmt.run(assignedBatch, p.id);
        }
      });
    })();

    res.json({ message: 'Batches updated without re-shuffling existing players!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/unlock-batches', (req, res) => {
  try {
    db.prepare('UPDATE players SET batch = NULL').run();
    res.json({ message: 'Batches unlocked successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rounds/generate', (req, res) => {
  try {
    const roundNumber = parseInt(req.body.roundNumber, 10);
    const targetBatch = req.body.batch || null;

    if (isNaN(roundNumber) || roundNumber < 1) {
      return res.status(400).json({ error: 'Valid roundNumber is required.' });
    }

    const allPlayers = db.prepare('SELECT * FROM players ORDER BY points DESC, sonneborn_berger DESC, buchholz DESC, manual_rank DESC').all();
    const totalCount = allPlayers.length;

    if (totalCount < 2) {
      return res.status(400).json({ error: 'At least 2 players required to generate pairings.' });
    }

    if (totalCount >= 10 && !targetBatch) {
      return res.status(400).json({ 
        error: '10 or more players registered. Please specify a batch ("A" or "B") when generating pairings.' 
      });
    }

    let pool = allPlayers;
    if (totalCount >= 10 && targetBatch) {
      pool = allPlayers.filter(p => p.batch === targetBatch);
    }

    let maxRounds = 3;
    let formatToUse = 'SWISS';

    if (pool.length <= 4) {
      formatToUse = 'ROUND_ROBIN';
      maxRounds = 6;
    } else {
      formatToUse = 'SWISS';
      maxRounds = 3;
    }

    if (roundNumber > maxRounds) {
      return res.status(400).json({
        error: `Maximum round limit (${maxRounds}) for this batch reached!`
      });
    }

    const createdMatches = [];

    db.transaction(() => {
      if (targetBatch) {
        db.prepare("DELETE FROM matches WHERE round_number = ? AND stage = 'STAGE_1' AND batch = ?").run(roundNumber, targetBatch);
      } else {
        db.prepare("DELETE FROM matches WHERE round_number = ? AND stage = 'STAGE_1'").run(roundNumber);
      }

      const insertMatch = db.prepare(
        "INSERT INTO matches (round_number, board_number, white_id, black_id, result, is_bye, winner_id, stage, batch) VALUES (?, ?, ?, ?, ?, ?, ?, 'STAGE_1', ?)"
      );

      let boardTracker = 1;

      if (formatToUse === 'ROUND_ROBIN') {
        const pairings = generateRoundRobinPairings(pool, roundNumber);

        for (const pair of pairings) {
          if (pair.isBye) {
            const info = insertMatch.run(roundNumber, null, pair.white.id, null, '1-0', 1, pair.white.id, targetBatch);
            createdMatches.push({
              id: info.lastInsertRowid,
              roundNumber,
              boardNumber: null,
              white_name: pair.white.name,
              black_name: 'BYE (1 Pt)',
              result: '1-0',
              batch: targetBatch
            });
          } else {
            const currentBoard = boardTracker++;
            const info = insertMatch.run(roundNumber, currentBoard, pair.white.id, pair.black.id, 'PENDING', 0, null, targetBatch);
            createdMatches.push({
              id: info.lastInsertRowid,
              roundNumber,
              boardNumber: currentBoard,
              white_name: pair.white.name,
              black_name: pair.black.name,
              result: 'PENDING',
              batch: targetBatch
            });
          }
        }
      } else {
        let activePlayers = [...pool];
        let byePlayer = null;

        // Handle odd player counts by giving a bye to the lowest ranked player who hasn't had one yet
        if (activePlayers.length % 2 !== 0) {
          for (let i = activePlayers.length - 1; i >= 0; i--) {
            if (!activePlayers[i].has_bye) {
              byePlayer = activePlayers.splice(i, 1)[0];
              break;
            }
          }
          if (!byePlayer) byePlayer = activePlayers.pop();
        }

        if (byePlayer) {
          const info = insertMatch.run(roundNumber, null, byePlayer.id, null, '1-0', 1, byePlayer.id, targetBatch);
          db.prepare('UPDATE players SET has_bye = 1 WHERE id = ?').run(byePlayer.id);
          createdMatches.push({
            id: info.lastInsertRowid,
            roundNumber,
            boardNumber: null,
            white_name: byePlayer.name,
            black_name: 'BYE (1 Pt)',
            result: '1-0',
            batch: targetBatch
          });
        }

        // Generate Swiss pairings dynamically based on current standings and match history
        const pairings = generateSwissPairings(activePlayers);

        for (const pair of pairings) {
          const currentBoard = boardTracker++;
          const info = insertMatch.run(roundNumber, currentBoard, pair.white.id, pair.black.id, 'PENDING', 0, null, targetBatch);
          createdMatches.push({
            id: info.lastInsertRowid,
            roundNumber,
            boardNumber: currentBoard,
            white_name: pair.white.name,
            black_name: pair.black.name,
            result: 'PENDING',
            batch: targetBatch
          });
        }
      }
    })();

    updateAllTieBreaks();
    res.json({ roundNumber, formatUsed: formatToUse, batch: targetBatch, matches: createdMatches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rounds/generate-stage2', (req, res) => {
  try {
    const roundNumber = parseInt(req.body.roundNumber, 10);

    if (isNaN(roundNumber) || roundNumber < 1 || roundNumber > 3) {
      return res.status(400).json({ error: 'Stage 2 requires roundNumber between 1 and 3.' });
    }

    const topA = db.prepare("SELECT id, name FROM players WHERE batch = 'A' ORDER BY points DESC, sonneborn_berger DESC, buchholz DESC, manual_rank DESC LIMIT 2").all();
    const topB = db.prepare("SELECT id, name FROM players WHERE batch = 'B' ORDER BY points DESC, sonneborn_berger DESC, buchholz DESC, manual_rank DESC LIMIT 2").all();

    const qualified = [...topA, ...topB];

    if (qualified.length < 4) {
      return res.status(400).json({ error: 'Need 4 qualified players (Top 2 from Batch A & B) for Stage 2.' });
    }

    db.transaction(() => {
      const markQualifiedStmt = db.prepare('UPDATE players SET stage_2_qualified = 1 WHERE id = ?');
      qualified.forEach(q => markQualifiedStmt.run(q.id));
    })();

    const pairings = generateRoundRobinPairings(qualified, roundNumber);
    const createdMatches = [];

    db.transaction(() => {
      db.prepare("DELETE FROM matches WHERE round_number = ? AND stage = 'STAGE_2'").run(roundNumber);

      const insertMatch = db.prepare(
        "INSERT INTO matches (round_number, board_number, white_id, black_id, result, is_bye, stage) VALUES (?, ?, ?, ?, 'PENDING', 0, 'STAGE_2')"
      );

      let boardTracker = 1;
      for (const pair of pairings) {
        if (!pair.isBye) {
          const currentBoard = boardTracker++;
          const info = insertMatch.run(roundNumber, currentBoard, pair.white.id, pair.black.id);
          createdMatches.push({
            id: info.lastInsertRowid,
            roundNumber,
            boardNumber: currentBoard,
            white_name: pair.white.name,
            black_name: pair.black.name,
            result: 'PENDING'
          });
        }
      }
    })();

    res.json({ message: 'Stage 2 round-robin pairing generated', roundNumber, matches: createdMatches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rounds/generate-playoffs', (req, res) => {
  try {
    const topA = db.prepare(
      "SELECT id, name FROM players WHERE batch = 'A' ORDER BY points DESC, sonneborn_berger DESC, buchholz DESC, manual_rank DESC, name ASC LIMIT 2"
    ).all();

    const topB = db.prepare(
      "SELECT id, name FROM players WHERE batch = 'B' ORDER BY points DESC, sonneborn_berger DESC, buchholz DESC, manual_rank DESC, name ASC LIMIT 2"
    ).all();

    if (topA.length < 2 || topB.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 players from both Batch A and Batch B to generate playoffs.' });
    }

    const a1 = topA[0];
    const a2 = topA[1];
    const b1 = topB[0];
    const b2 = topB[1];

    const createdMatches = [];

    db.transaction(() => {
      db.prepare("DELETE FROM matches WHERE stage = 'PLAYOFFS'").run();

      const insertMatch = db.prepare(
        "INSERT INTO matches (round_number, board_number, white_id, black_id, result, is_bye, stage) VALUES (1, ?, ?, ?, 'PENDING', 0, 'PLAYOFFS')"
      );

      const sf1 = insertMatch.run(1, a1.id, b2.id);
      createdMatches.push({
        id: sf1.lastInsertRowid,
        boardNumber: 1,
        matchType: 'Semi-Final 1 (Batch A #1 vs Batch B #2)',
        white_name: a1.name,
        black_name: b2.name,
        result: 'PENDING'
      });

      const sf2 = insertMatch.run(2, b1.id, a2.id);
      createdMatches.push({
        id: sf2.lastInsertRowid,
        boardNumber: 2,
        matchType: 'Semi-Final 2 (Batch B #1 vs Batch A #2)',
        white_name: b1.name,
        black_name: a2.name,
        result: 'PENDING'
      });
    })();

    res.json({ message: 'Playoff semi-finals generated successfully!', matches: createdMatches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/playoffs/matches', (req, res) => {
  try {
    const matches = db.prepare(`
      SELECT m.id, m.round_number, m.board_number, m.result, m.stage,
             p1.name AS white_name, 
             p2.name AS black_name
      FROM matches m
      LEFT JOIN players p1 ON m.white_id = p1.id
      LEFT JOIN players p2 ON m.black_id = p2.id
      WHERE m.stage = 'PLAYOFFS'
      ORDER BY m.board_number ASC
    `).all();

    const formattedMatches = matches.map(m => ({
      ...m,
      matchType: m.board_number === 1 ? '1st & 2nd Place Final' : '3rd & 4th Place Playoff'
    }));

    res.json(formattedMatches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/playoffs/score', (req, res) => {
  try {
    const { matchId, result } = req.body;
    const match = db.prepare("SELECT * FROM matches WHERE id = ? AND stage = 'PLAYOFFS'").get(matchId);

    if (!match) {
      return res.status(404).json({ error: 'Playoff match not found' });
    }

    const validResults = ['1-0', '0-1', '0.5-0.5', 'ABORTED'];
    if (!validResults.includes(result)) {
      return res.status(400).json({ error: 'Invalid result value.' });
    }

    let winnerId = null;
    if (result === '1-0') winnerId = match.white_id;
    else if (result === '0-1') winnerId = match.black_id;

    db.prepare('UPDATE matches SET result = ?, winner_id = ? WHERE id = ?').run(result, winnerId, matchId);

    res.json({ message: `Playoff match result set to ${result}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/playoffs/status', (req, res) => {
  try {
    const pendingMatches = db.prepare(
      "SELECT COUNT(*) as count FROM matches WHERE result = 'PENDING' AND stage != 'PLAYOFFS'"
    ).get().count;

    const totalStageMatches = db.prepare(
      "SELECT COUNT(*) as count FROM matches WHERE stage != 'PLAYOFFS'"
    ).get().count;

    const canGeneratePlayoffs = totalStageMatches > 0 && pendingMatches === 0;

    const standings = db.prepare(
      'SELECT id, name, points, buchholz, COALESCE(sonneborn_berger, 0) AS sonneborn_berger FROM players ORDER BY points DESC, sonneborn_berger DESC, buchholz DESC, manual_rank DESC LIMIT 4'
    ).all();

    let isTiedAtCutoff = false;
    if (standings.length >= 2) {
      const p1 = standings[0];
      const p2 = standings[1];
      if (
        p1.points === p2.points && 
        p1.sonneborn_berger === p2.sonneborn_berger && 
        p1.buchholz === p2.buchholz
      ) {
        isTiedAtCutoff = true;
      }
    }

    res.json({
      canGeneratePlayoffs,
      pendingMatches,
      totalStageMatches,
      isTiedAtCutoff
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/standings', (req, res) => {
  try {
    const { batch, stage } = req.query;
    
    let query = `
      SELECT id, name, points, stage_2_points, buchholz, 
             COALESCE(sonneborn_berger, 0) AS sonneborn_berger, 
             COALESCE(manual_rank, 0) AS manual_rank,
             batch, stage_2_qualified 
      FROM players
    `;
    let params = [];
    let conditions = [];

    if (batch) {
      conditions.push('batch = ?');
      params.push(batch);
    }

    if (stage === 'STAGE_2') {
      conditions.push('(stage_2_qualified = 1 OR stage_2_qualified = 3)');
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    if (stage === 'STAGE_2') {
      query += ' ORDER BY stage_2_points DESC, manual_rank DESC, name ASC';
    } else {
      query += ' ORDER BY points DESC, sonneborn_berger DESC, buchholz DESC, manual_rank DESC, name ASC';
    }

    const standings = db.prepare(query).all(...params);
    res.json(standings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/planner', (req, res) => {
  try {
    const playersCount = db.prepare('SELECT COUNT(*) as count FROM players').get().count;
    const boardSetting = db.prepare("SELECT value FROM settings WHERE key = 'board_count'").get();
    const numBoards = boardSetting ? parseInt(boardSetting.value, 10) : 4;

    let plan = {};
    if (playersCount < 2) {
      plan = { message: 'Register at least 2 players to compute schedule.' };
    } else if (playersCount <= 4) {
      plan = {
        format: 'Double Round-Robin',
        players: playersCount,
        boards: numBoards,
        recommendedRounds: 6,
        estimated10Plus2Mins: 6 * 13
      };
    } else if (playersCount <= 9) {
      plan = {
        format: '5-Round Swiss',
        players: playersCount,
        boards: numBoards,
        recommendedRounds: 5,
        estimated10Plus2Mins: 5 * 13
      };
    } else {
      plan = {
        format: '2-Batch Swiss (Stage 1) + Top 4 Round-Robin (Stage 2)',
        players: playersCount,
        boards: numBoards,
        stage1: { batches: 2, roundsPerBatch: 3 },
        stage2: { qualifiedPlayers: 4, rounds: 3 },
        estimated10Plus2Mins: (3 * 2 * 13) + (3 * 13)
      };
    }

    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/crosstable', (req, res) => {
  try {
    const players = db.prepare('SELECT id, name, points FROM players ORDER BY id ASC').all();
    const matches = db.prepare("SELECT white_id, black_id, result FROM matches WHERE is_bye = 0 AND result NOT IN ('PENDING', 'ABORTED')").all();

    const grid = {};

    matches.forEach(m => {
      if (m.result === '1-0') {
        grid[`${m.white_id}-${m.black_id}`] = '1';
        grid[`${m.black_id}-${m.white_id}`] = '0';
      } else if (m.result === '0-1') {
        grid[`${m.white_id}-${m.black_id}`] = '0';
        grid[`${m.black_id}-${m.white_id}`] = '1';
      } else if (m.result === '0.5-0.5') {
        grid[`${m.white_id}-${m.black_id}`] = '½';
        grid[`${m.black_id}-${m.white_id}`] = '½';
      }
    });

    res.json({ players, grid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rounds/:roundNumber', (req, res) => {
  try {
    const { batch, stage } = req.query;
    let query = `
      SELECT m.id, m.round_number, m.board_number, m.result, m.is_bye, m.stage, m.batch,
             p1.name AS white_name, 
             COALESCE(p2.name, 'BYE') AS black_name
      FROM matches m
      LEFT JOIN players p1 ON m.white_id = p1.id
      LEFT JOIN players p2 ON m.black_id = p2.id
      WHERE m.round_number = ?
    `;
    const params = [req.params.roundNumber];

    if (stage) {
      query += ' AND m.stage = ?';
      params.push(stage);
    } else {
      query += " AND m.stage = 'STAGE_1'";
    }

    if (batch) {
      query += ' AND m.batch = ?';
      params.push(batch);
    }

    query += ' ORDER BY m.board_number ASC';

    const matches = db.prepare(query).all(...params);
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API to fetch the winners for the winners page
app.get('/api/results/final', (req, res) => {
  res.json(tournamentWinners);
});

app.post('/api/matches/score', (req, res) => {
  try {
    const { matchId, result } = req.body;
    const match = db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);

    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.is_bye) return res.status(400).json({ error: 'Cannot modify a Bye match result' });

    const validResults = ['1-0', '0-1', '0.5-0.5', 'ABORTED'];
    if (!validResults.includes(result)) {
      return res.status(400).json({ error: 'Invalid result value.' });
    }

    let winnerId = null;
    if (result === '1-0') winnerId = match.white_id;
    else if (result === '0-1') winnerId = match.black_id;

    db.prepare('UPDATE matches SET result = ?, winner_id = ? WHERE id = ?').run(result, winnerId, matchId);

    updateAllTieBreaks();
    res.json({ message: `Match result set to ${result}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset', (req, res) => {
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM matches').run();
      db.prepare('DELETE FROM players').run();
      db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('matches', 'players')").run();
    })();
    res.json({ message: 'Tournament data completely reset.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API to save the winners when the tournament finishes
app.post('/api/results/finalize', (req, res) => {
  const { winnerName, runnerUpName } = req.body;
  if (!winnerName || !runnerUpName) {
    return res.status(400).json({ error: 'Winner and runner-up names are required.' });
  }
  
  tournamentWinners = {
    winner: winnerName,
    runnerUp: runnerUpName,
    finalizedAt: new Date().toISOString()
  };
  
  console.log('Tournament finalized successfully:', tournamentWinners);
  res.json({ success: true, tournamentWinners });
});

// Static files & frontend routes
app.use(express.static(path.join(__dirname, 'public')));
app.get('/registration', (req, res) => res.sendFile(path.join(__dirname, 'public', 'registration.html')));
app.get('/schedule', (req, res) => res.sendFile(path.join(__dirname, 'public', 'schedule.html')));
app.get('/standings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'standings.html')));
app.get('/pairings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pairings.html')));
app.get('/playoffs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'playoffs.html')));
app.get('/winners', (req, res) => res.sendFile(path.join(__dirname, 'public', 'winners.html')));
app.get('/guide', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guide.html')));
app.get('/', (req, res) => res.redirect('/standings'));

app.use('/api', (req, res) => {
  console.log(`❌ Missing API Endpoint: [${req.method}] ${req.originalUrl}`);
  res.status(404).json({ 
    error: `API endpoint [${req.method}] ${req.originalUrl} not found` 
  });
});

app.use((req, res) => {
  res.status(404).send('Page Not Found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
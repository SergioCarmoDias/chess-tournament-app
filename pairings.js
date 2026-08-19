const db = require('./db');

/**
 * Assigns players into Batch A and Batch B if >= 10 players exist and batches are unassigned.
 */
function autoAssignBatches() {
  const players = db.prepare("SELECT id, batch FROM players ORDER BY id ASC").all();
  
  // Check if any player already has a valid batch ('A' or 'B')
  const hasExistingBatches = players.some(p => p.batch === 'A' || p.batch === 'B');
  
  if (players.length >= 10 && !hasExistingBatches) {
    const totalPlayers = players.length;
    let half = Math.floor(totalPlayers / 2);

    // Keep split size as an even number (e.g., 10 -> 6 and 4)
    if (half % 2 !== 0) {
      half += 1;
    }

    const updateBatch = db.prepare('UPDATE players SET batch = ? WHERE id = ?');
    db.transaction(() => {
      players.forEach((p, index) => {
        const batchName = index < half ? 'A' : 'B';
        updateBatch.run(batchName, p.id);
      });
    })();
  }
}

/**
 * Generates pairings for a given round based on tournament settings.
 */
function generatePairings(roundNumber) {
  // 1. Auto-assign batches first
  autoAssignBatches();

  // Check if round already has generated matches
  const existingMatches = db.prepare('SELECT COUNT(*) as count FROM matches WHERE round_number = ?').get(roundNumber);
  if (existingMatches && existingMatches.count > 0) {
    throw new Error(`Matches for Round ${roundNumber} have already been generated.`);
  }

  // Get tournament settings
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'tournament_type'").get();
  const tournamentType = setting ? setting.value : 'SWISS';

  // Fetch players AFTER autoAssignBatches execution
  const players = db.prepare('SELECT id, points, has_bye, batch FROM players ORDER BY points DESC, id ASC').all();
  if (players.length < 2) {
    throw new Error('Need at least 2 players to generate pairings.');
  }

  // Filter distinct active batches (exclude null, undefined, or empty string)
  const batches = [...new Set(players.map(p => p.batch).filter(b => b === 'A' || b === 'B'))];

  if (batches.length > 0) {
    // Run pairing algorithm for EACH batch independently
    for (const batchName of batches) {
      const batchPlayers = players.filter(p => p.batch === batchName);
      if (batchPlayers.length < 2) continue;

      if (tournamentType === 'ROUND_ROBIN') {
        generateRoundRobin(roundNumber, batchPlayers, batchName);
      } else {
        generateSwiss(roundNumber, batchPlayers, batchName);
      }
    }
    return true;
  } else {
    // Standard pairing for unbatched players (< 10 players)
    if (tournamentType === 'ROUND_ROBIN') {
      return generateRoundRobin(roundNumber, players, null);
    } else {
      return generateSwiss(roundNumber, players, null);
    }
  }
}

/**
 * Swiss Pairing Algorithm
 */
function generateSwiss(roundNumber, players, batch = null) {
  const insertMatch = db.prepare(`
    INSERT INTO matches (round_number, white_id, black_id, result, winner_id, is_bye, batch)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Query previous matches filtered by batch
  let query = 'SELECT white_id, black_id FROM matches WHERE is_bye = 0';
  let params = [];
  if (batch) {
    query += ' AND batch = ?';
    params.push(batch);
  }
  
  const previousMatches = db.prepare(query).all(...params);
  const playedPairs = new Set();
  previousMatches.forEach(m => {
    playedPairs.add(`${m.white_id}-${m.black_id}`);
    playedPairs.add(`${m.black_id}-${m.white_id}`);
  });

  let activePlayers = [...players];

  // Assign Bye if odd number of players in this batch
  if (activePlayers.length % 2 !== 0) {
    let byeIndex = -1;
    for (let i = activePlayers.length - 1; i >= 0; i--) {
      if (!activePlayers[i].has_bye) {
        byeIndex = i;
        break;
      }
    }

    if (byeIndex === -1) byeIndex = activePlayers.length - 1;

    const byePlayer = activePlayers.splice(byeIndex, 1)[0];

    db.transaction(() => {
      insertMatch.run(roundNumber, byePlayer.id, null, '1-0', byePlayer.id, 1, batch);
      db.prepare('UPDATE players SET points = points + 1, has_bye = 1 WHERE id = ?').run(byePlayer.id);
    })();
  }

  // Pair remaining players within batch
  const pairings = [];
  while (activePlayers.length > 0) {
    const white = activePlayers.shift();
    let partnerIndex = -1;

    for (let i = 0; i < activePlayers.length; i++) {
      const candidate = activePlayers[i];
      if (!playedPairs.has(`${white.id}-${candidate.id}`)) {
        partnerIndex = i;
        break;
      }
    }

    if (partnerIndex === -1 && activePlayers.length > 0) partnerIndex = 0;

    if (partnerIndex !== -1) {
      const black = activePlayers.splice(partnerIndex, 1)[0];
      pairings.push({ whiteId: white.id, blackId: black.id });
    }
  }

  // Insert match pairings inside transaction
  const createMany = db.transaction((pairs) => {
    for (const p of pairs) {
      insertMatch.run(roundNumber, p.whiteId, p.blackId, 'PENDING', null, 0, batch);
    }
  });

  createMany(pairings);
  return true;
}

/**
 * Round Robin (Berger System Rotation)
 */
function generateRoundRobin(roundNumber, players, batch = null) {
  let playerList = players.map(p => p.id);
  
  if (playerList.length % 2 !== 0) {
    playerList.push(null);
  }

  const numPlayers = playerList.length;
  const totalRounds = numPlayers - 1;

  if (roundNumber > totalRounds) {
    throw new Error(`Round Robin tournament for ${batch ? 'Batch ' + batch : 'all players'} only has ${totalRounds} rounds.`);
  }

  const rotationOffset = (roundNumber - 1) % (numPlayers - 1);
  const fixed = playerList[0];
  const rest = playerList.slice(1);

  for (let i = 0; i < rotationOffset; i++) {
    rest.unshift(rest.pop());
  }

  const rotated = [fixed, ...rest];
  const insertMatch = db.prepare(`
    INSERT INTO matches (round_number, white_id, black_id, result, winner_id, is_bye, batch)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (let i = 0; i < numPlayers / 2; i++) {
      let p1 = rotated[i];
      let p2 = rotated[numPlayers - 1 - i];

      if (p1 === null || p2 === null) {
        const byePlayerId = p1 || p2;
        insertMatch.run(roundNumber, byePlayerId, null, '1-0', byePlayerId, 1, batch);
        db.prepare('UPDATE players SET points = points + 1, has_bye = 1 WHERE id = ?').run(byePlayerId);
      } else {
        const white = (i + roundNumber) % 2 === 0 ? p1 : p2;
        const black = white === p1 ? p2 : p1;
        insertMatch.run(roundNumber, white, black, 'PENDING', null, 0, batch);
      }
    }
  })();

  return true;
}

/**
 * Updates match results and adjusts player scores.
 */
function submitMatchScore(matchId, result) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) throw new Error('Match not found.');
  if (match.is_bye) throw new Error('Cannot edit automatic bye result.');

  let winnerId = null;
  let whitePointsDelta = 0;
  let blackPointsDelta = 0;

  if (match.result === '1-0') {
    whitePointsDelta -= 1;
  } else if (match.result === '0-1') {
    blackPointsDelta -= 1;
  } else if (match.result === '0.5-0.5') {
    whitePointsDelta -= 0.5;
    blackPointsDelta -= 0.5;
  }

  if (result === '1-0') {
    winnerId = match.white_id;
    whitePointsDelta += 1;
  } else if (result === '0-1') {
    winnerId = match.black_id;
    blackPointsDelta += 1;
  } else if (result === '0.5-0.5') {
    whitePointsDelta += 0.5;
    blackPointsDelta += 0.5;
  }

  db.transaction(() => {
    db.prepare('UPDATE matches SET result = ?, winner_id = ? WHERE id = ?').run(result, winnerId, matchId);
    db.prepare('UPDATE players SET points = points + ? WHERE id = ?').run(whitePointsDelta, match.white_id);
    db.prepare('UPDATE players SET points = points + ? WHERE id = ?').run(blackPointsDelta, match.black_id);
  })();

  return true;
}

module.exports = { generatePairings, submitMatchScore };
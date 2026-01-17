// Test Firebase function
async function testFirebase() {
    try {
        const docRef = await db.collection("debug").add({
            message: "Hello Firebase",
            time: Date.now()
        });
        console.log("testFirebase success: Document written with ID: ", docRef.id);
    } catch (e) {
        console.error("testFirebase error: ", e);
    }
}
window.testFirebase = testFirebase;
// Perform test write
testFirebase();

const BOARD_SIZE = 15;
const boardElement = document.getElementById('board');
const statusElement = document.getElementById('status');

// We need to query this inside updateStatus/resetGame now because it might be overwritten by innerHTML updates
let playerTurnSpan = document.querySelector('.player-turn');

let board = [];
let currentPlayer = 'black';
let gameOver = false;
let isVsAI = true; // Still used for internal logic, but effectively determined by 'mode'
let difficulty = 'hard';

// --- Online Global State ---
let mode = null; // 'ai' or 'online', initially null until selected
let roomId = null;
let playerRole = null; // 'black', 'white', 'spectator', or null
let roomUnsubscribe = null;

// --- Client ID Logic ---
let clientId = localStorage.getItem('gomoku_clientId');
if (!clientId) {
    clientId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('gomoku_clientId', clientId);
}

// --- View Navigation ---
function showView(viewName) {
    // Hide all main containers
    document.getElementById('landing-page').classList.add('hidden');
    document.getElementById('game-container').classList.add('hidden');

    // Hide all sub-sections in game container
    document.getElementById('ai-controls').classList.add('hidden');
    document.getElementById('online-lobby').classList.add('hidden');
    document.getElementById('online-room').classList.add('hidden');
    document.getElementById('game-board-area').classList.add('hidden');

    switch (viewName) {
        case 'landing':
            document.getElementById('landing-page').classList.remove('hidden');
            document.getElementById('mode-selection').classList.add('hidden'); // Reset selection
            break;
        case 'ai-game':
            document.getElementById('game-container').classList.remove('hidden');
            document.getElementById('ai-controls').classList.remove('hidden');
            document.getElementById('game-board-area').classList.remove('hidden');
            break;
        case 'online-lobby':
            document.getElementById('game-container').classList.remove('hidden');
            document.getElementById('online-lobby').classList.remove('hidden');
            break;
        case 'online-room':
            document.getElementById('game-container').classList.remove('hidden');
            document.getElementById('online-room').classList.remove('hidden');
            document.getElementById('game-board-area').classList.remove('hidden');
            break;
    }
}

function toggleModeSelection() {
    const selectionDiv = document.getElementById('mode-selection');
    selectionDiv.classList.remove('hidden');
}

function selectMode(selectedMode) {
    mode = selectedMode;
    if (mode === 'ai') {
        showView('ai-game');
        isVsAI = true;
        resetGame();
    } else if (mode === 'online') {
        showView('online-lobby');
        isVsAI = false;
        listenToRoomCounts();
    }
}

function backToLanding() {
    showView('landing');
}

document.addEventListener('DOMContentLoaded', () => {
    const difficultySelect = document.getElementById('difficulty');
    if (difficultySelect) {
        difficultySelect.addEventListener('change', (e) => {
            difficulty = e.target.value;
        });
    }
});

function resetGame() {
    // Clear board state
    board = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
        const rowArray = [];
        for (let c = 0; c < BOARD_SIZE; c++) {
            rowArray.push(null);
        }
        board.push(rowArray);
    }

    // Clear stones on the UI without removing cells
    const cells = document.querySelectorAll('.cell');
    if (cells.length === 0) {
        createBoard();
    } else {
        cells.forEach(cell => {
            cell.innerHTML = '';
        });
    }

    // Reset flags and current player
    currentPlayer = 'black';
    gameOver = false;
    isVsAI = true; // Ensure AI mode is on

    // Reset status text
    statusElement.innerHTML = '當前回合：<span class="player-turn" style="color: #000">黑子</span>';

    // key step: update the reference to the span because we just replaced the innerHTML
    playerTurnSpan = document.querySelector('.player-turn');
}

function createBoard() {
    boardElement.innerHTML = '';
    for (let row = 0; row < BOARD_SIZE; row++) {
        const rowArray = [];
        for (let col = 0; col < BOARD_SIZE; col++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            cell.dataset.row = row;
            cell.dataset.col = col;
            cell.addEventListener('click', () => handleCellClick(row, col));
            boardElement.appendChild(cell);
        }
    }
}

function handleCellClick(row, col) {
    if (gameOver) return;

    // --- Online Mode Logic ---
    if (mode === 'online') {
        if (!roomId || !playerRole || (playerRole !== 'black' && playerRole !== 'white')) return;
        if (currentPlayer !== playerRole) return;
        if (board[row][col] !== null) return;

        const roomRef = db.collection('rooms').doc(roomId);

        db.runTransaction(async (transaction) => {
            const doc = await transaction.get(roomRef);
            if (!doc.exists) throw "Room does not exist";

            const data = doc.data();
            if (data.gameOver) throw "Game is over";
            if (data.currentPlayer !== playerRole) throw "Not your turn";

            // Check occupancy using 1D index
            const index = row * BOARD_SIZE + col;
            if (data.board[index] !== null) throw "Cell occupied";

            // Prepare new board state (1D array)
            const newBoard1D = [...data.board];
            newBoard1D[index] = playerRole;

            // To check win, we need to temporarily construct a 2D board or use the 1D array
            // But our checkWin helper expects a 2D array by default or boardState.
            // Let's create a temporary 2D board for checkWin for simplicity and safety
            const tempBoard2D = [];
            for (let r = 0; r < BOARD_SIZE; r++) {
                const rowArr = [];
                for (let c = 0; c < BOARD_SIZE; c++) {
                    rowArr.push(newBoard1D[r * BOARD_SIZE + c]);
                }
                tempBoard2D.push(rowArr);
            }

            const isWin = checkWin(row, col, playerRole, true, tempBoard2D);

            const updates = {
                board: newBoard1D,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            if (isWin) {
                updates.gameOver = true;
            } else {
                updates.currentPlayer = (playerRole === 'black') ? 'white' : 'black';
            }

            transaction.update(roomRef, updates);
        }).catch(err => {
            console.error("Move transaction failed:", err);
        });

        return;
    }

    // --- AI Mode Logic ---
    if (board[row][col] !== null) {
        return;
    }

    // Prevent user from clicking during AI's turn
    if (isVsAI && currentPlayer === 'white') {
        return;
    }

    placeStone(row, col);

    if (checkWin(row, col, currentPlayer)) {
        statusElement.innerHTML = `<span class="player-turn" style="color: ${currentPlayer === 'black' ? '#000' : '#888'}">${getPlayerName(currentPlayer)} 獲勝！</span>`;
        return;
    }

    switchTurn();

    // Trigger AI move if it's white's turn
    if (isVsAI && currentPlayer === 'white' && !gameOver) {
        setTimeout(makeAIMove, 500);
    }
}

function makeAIMove() {
    if (gameOver) return;

    let move;
    if (difficulty === 'easy') {
        move = findEasyMove();
    } else if (difficulty === 'medium') {
        move = findMediumMove();
    } else {
        move = findBestMove(); // Hard (Original)
    }

    if (move) {
        placeStone(move.r, move.c);
        if (checkWin(move.r, move.c, currentPlayer)) {
            statusElement.innerHTML = `<span class="player-turn" style="color: ${currentPlayer === 'black' ? '#000' : '#888'}">${getPlayerName(currentPlayer)} 獲勝！</span>`;
            return;
        }
        switchTurn();
    }
}

// EASY: Only block immediate 4-in-a-row threats. Otherwise random.
function findEasyMove() {
    // 1. Check for immediate threats (defense score high)
    // We scan all empty spots. If 'black' (human) has a high score there, we block.
    // Threat threshold: Dead 4 requires blocking (Score 10000)

    let candidates = [];

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            if (board[r][c] === null) {
                // Check if human wins or has 4
                const defenseScore = evaluatePoint(r, c, 'black');
                if (defenseScore >= 10000) {
                    return { r, c }; // Must block immediately
                }
                candidates.push({ r, c });
            }
        }
    }

    // 2. No immediate threat, pick random
    if (candidates.length > 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
    }
    return { r: 7, c: 7 };
}

// MEDIUM: Pick from top moves but prioritize blocking
function findMediumMove() {
    let allMoves = [];
    let mustBlockMoves = [];

    // Evaluate every empty cell and store score
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            if (board[r][c] === null) {
                const attackScore = evaluatePoint(r, c, 'white');
                const defenseScore = evaluatePoint(r, c, 'black');

                // If defense score is high (blocking 3 or 4), we MUST consider this serious
                // Threshold 5000 covers blocking "Live 3" (becomes "Live 4" if ignored) and "Dead 4"
                if (defenseScore >= 2000) {
                    mustBlockMoves.push({ r, c, score: defenseScore });
                }

                let totalScore = attackScore + defenseScore;

                // Heuristic
                const centerDist = Math.abs(r - 7) + Math.abs(c - 7);
                totalScore -= centerDist;

                allMoves.push({ r, c, score: totalScore });
            }
        }
    }

    // 1. Safety Check: If there are urgent defensive moves, pick the best one essentially (behaving like Hard)
    // or at least pick one of them randomly if they are similar.
    // For Medium, let's say: if threat exists, ACTUALLY BLOCK IT. 
    // Don't act dumb when you are about to lose.
    if (mustBlockMoves.length > 0) {
        mustBlockMoves.sort((a, b) => b.score - a.score);
        return mustBlockMoves[0];
    }

    // 2. No immediate threat: Sort all moves descending
    allMoves.sort((a, b) => b.score - a.score);

    // Pick from top 3-5 to give some randomness but stay reasonable
    const topN = 4;
    const poolSize = Math.min(allMoves.length, topN);

    if (poolSize > 0) {
        // Weighted random could be better, but simple random slice is fine for "Medium"
        const randomIndex = Math.floor(Math.random() * poolSize);
        return allMoves[randomIndex];
    }

    return { r: 7, c: 7 };
}

// HARD: Best Move (Original Logic, slightly cleaned up)
function findBestMove() {
    let bestScore = -Infinity;
    let bestMoves = [];

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            if (board[r][c] === null) {
                const attackScore = evaluatePoint(r, c, 'white');
                const defenseScore = evaluatePoint(r, c, 'black');
                let totalScore = attackScore + defenseScore;

                const centerDist = Math.abs(r - 7) + Math.abs(c - 7);
                totalScore -= centerDist;

                if (totalScore > bestScore) {
                    bestScore = totalScore;
                    bestMoves = [{ r, c }];
                } else if (totalScore === bestScore) {
                    bestMoves.push({ r, c });
                }
            }
        }
    }

    if (bestMoves.length > 0) {
        const randomIndex = Math.floor(Math.random() * bestMoves.length);
        return bestMoves[randomIndex];
    }
    return { r: 7, c: 7 };
}

function evaluatePoint(row, col, player) {
    let totalScore = 0;

    // Check all 4 directions
    const directions = [
        [0, 1],   // horizontal
        [1, 0],   // vertical
        [1, 1],   // diagonal right-down
        [1, -1]   // diagonal left-down
    ];

    for (const [dx, dy] of directions) {
        const analysis = analyzeLine(row, col, dx, dy, player);
        totalScore += getScore(analysis.count, analysis.openEnds);
    }

    return totalScore;
}

function analyzeLine(row, col, dx, dy, player) {
    let count = 0;
    let openEnds = 0;

    // Check forward
    let i = 1;
    while (true) {
        const r = row + i * dx;
        const c = col + i * dy;
        if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
            break; // Hit wall
        }
        if (board[r][c] === player) {
            count++;
        } else if (board[r][c] === null) {
            openEnds++;
            break; // Hit empty space
        } else {
            break; // Hit opponent stone
        }
        i++;
    }

    // Check backward
    i = 1;
    while (true) {
        const r = row - i * dx;
        const c = col - i * dy;
        if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
            break; // Hit wall
        }
        if (board[r][c] === player) {
            count++;
        } else if (board[r][c] === null) {
            openEnds++;
            break; // Hit empty space
        } else {
            break; // Hit opponent stone
        }
        i++;
    }

    // Determine contiguous stones from this point (current stone is virtual +1)
    // Actually our loop counts stones *next* to the target. So if we have 2 on left and 1 on right,
    // placing here makes it 1+1+2 = 4 stones.
    // So 'count' here is actually just neighbors. We add 1 for the stone we are evaluating.
    return { count: count + 1, openEnds };
}


function getScore(count, openEnds) {
    if (openEnds === 0 && count < 5) return 0; // Completely blocked, worthless unless 5

    switch (count) {
        case 5:
            return 1000000; // Win
        case 4:
            if (openEnds === 2) return 100000; // Live 4 (Unstoppable)
            if (openEnds === 1) return 10000;  // Dead 4 (Must block/win)
            return 0;
        case 3:
            if (openEnds === 2) return 5000;   // Live 3 (Block or extended to 4)
            if (openEnds === 1) return 100;    // Dead 3
            return 0;
        case 2:
            if (openEnds === 2) return 50;     // Live 2
            if (openEnds === 1) return 5;
            return 0;
        case 1:
            if (openEnds === 2) return 5;      // Live 1
            if (openEnds === 1) return 1;
            return 0;
        default:
            return 1000000; // >5 usually treated as win in Gomoku variants or at least 5
    }
}

function placeStone(row, col) {
    board[row][col] = currentPlayer;
    const cell = document.querySelector(`.cell[data-row='${row}'][data-col='${col}']`);
    const stone = document.createElement('div');
    stone.classList.add('stone', currentPlayer);
    cell.appendChild(stone);
}

function switchTurn() {
    currentPlayer = currentPlayer === 'black' ? 'white' : 'black';
    updateStatus();
}

function updateStatus() {
    if (!playerTurnSpan) {
        playerTurnSpan = document.querySelector('.player-turn');
    }
    if (playerTurnSpan) {
        playerTurnSpan.textContent = getPlayerName(currentPlayer);
        playerTurnSpan.style.color = currentPlayer === 'black' ? '#000' : '#888';
    }
}

function getPlayerName(player) {
    return player === 'black' ? '黑子' : '白子';
}

function countDirection(row, col, dx, dy, player, boardState = board) {
    let count = 0;
    let r = row + dx;
    let c = col + dy;

    while (
        r >= 0 && r < 15 &&
        c >= 0 && c < 15 &&
        boardState[r][c] === player
    ) {
        count++;
        r += dx;
        c += dy;
    }
    return count;
}

// Added isSimulating flag to prevent alerts during AI calculation
function checkWin(row, col, player, isSimulating = false, boardState = board) {
    const directions = [
        [0, 1],   // horizontal
        [1, 0],   // vertical
        [1, 1],   // diagonal right-down
        [1, -1],  // diagonal left-down
    ];

    for (const [dx, dy] of directions) {
        const total =
            1 +
            countDirection(row, col, dx, dy, player, boardState) +
            countDirection(row, col, -dx, -dy, player, boardState);

        if (total >= 5) {
            if (!isSimulating && boardState === board) { // Only alert if using main board and not sim
                setTimeout(() => alert(getPlayerName(player) + " 獲勝！"), 10);
                gameOver = true;
            }
            return true;
        }
    }
    return false;
}

// Start the game
resetGame();

// --- Online Mode Functions ---

// Removed setMode() as it is replaced by selectMode() and showView() logic

function joinRoom(selectedRoomId) {
    if (roomId === selectedRoomId) return; // Already in this room

    // Leave previous room if any
    if (roomUnsubscribe) {
        roomUnsubscribe();
        roomUnsubscribe = null;
    }

    roomId = selectedRoomId;

    // Switch View
    showView('online-room');
    document.getElementById('current-room-id').textContent = roomId;

    // Reset Role UI
    document.getElementById('my-role').textContent = '觀眾';
    document.getElementById('btn-claim-black').disabled = false;
    document.getElementById('btn-claim-white').disabled = false;
    document.getElementById('btn-claim-spec').disabled = true; // Initially disabled as we are spec

    // Ensure board is visible immediately (empty state)
    boardElement.innerHTML = '';
    createBoard();

    const roomRef = db.collection('rooms').doc(roomId);

    db.runTransaction(async (transaction) => {
        const doc = await transaction.get(roomRef);

        if (!doc.exists) {
            // Create room if not exists
            transaction.set(roomRef, {
                board: Array(15 * 15).fill(null),
                currentPlayer: 'black',
                gameOver: false,
                players: { blackId: null, whiteId: null },
                spectators: [],
                heartbeats: { [clientId]: firebase.firestore.FieldValue.serverTimestamp() },
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            // New logic: Creator is just a spectator initially too, or we can make them generic
            // For now, follow flow -> Just create, join as spectator
            return { role: 'spectator' };
        }

        const data = doc.data();

        if (!data.spectators.includes(clientId)) {
            transaction.update(roomRef, {
                spectators: firebase.firestore.FieldValue.arrayUnion(clientId),
                [`heartbeats.${clientId}`]: firebase.firestore.FieldValue.serverTimestamp()
            });
        } else {
            // Even if already in, refresh heartbeat to prevent immediate timeout
            transaction.update(roomRef, {
                [`heartbeats.${clientId}`]: firebase.firestore.FieldValue.serverTimestamp()
            });
        }

        return { role: 'spectator' };
    }).then((result) => {
        playerRole = 'spectator'; // Default start
        bindRoomListener();
        startHeartbeat();
    }).catch((error) => {
        console.error("Join room failed: ", error);
        alert("加入了房間失敗: " + error.message);
        backToLanding();
    });
}

function becomePlayer(role) {
    if (!roomId) return;

    const roomRef = db.collection('rooms').doc(roomId);

    db.runTransaction(async (transaction) => {
        const doc = await transaction.get(roomRef);
        if (!doc.exists) throw "Room not found";

        const data = doc.data();

        if (role === 'black') {
            if (data.players.blackId && data.players.blackId !== clientId) throw "Black position taken";
            transaction.update(roomRef, {
                'players.blackId': clientId,
                // If we were white, clear it
                'players.whiteId': (data.players.whiteId === clientId) ? null : data.players.whiteId,
                'spectators': firebase.firestore.FieldValue.arrayRemove(clientId),
                [`heartbeats.${clientId}`]: firebase.firestore.FieldValue.serverTimestamp() // Update heartbeat immediately
            });
        } else if (role === 'white') {
            if (data.players.whiteId && data.players.whiteId !== clientId) throw "White position taken";
            transaction.update(roomRef, {
                'players.whiteId': clientId,
                // If we were black, clear it
                'players.blackId': (data.players.blackId === clientId) ? null : data.players.blackId,
                'spectators': firebase.firestore.FieldValue.arrayRemove(clientId),
                [`heartbeats.${clientId}`]: firebase.firestore.FieldValue.serverTimestamp() // Update heartbeat immediately
            });
        }
    }).then(() => {
        playerRole = role;
        // Optimization: Pre-update UI for responsiveness, though listener will catch it
        document.getElementById('my-role').textContent = getPlayerName(playerRole);
        // Buttons will be updated by room listener
    }).catch(err => {
        alert("無法加入該位置: " + err);
    });
}

function becomeSpectator() {
    if (!roomId) return;
    const roomRef = db.collection('rooms').doc(roomId);

    // If we are currently black or white, release that spot
    const updates = {};
    if (playerRole === 'black') updates['players.blackId'] = null;
    if (playerRole === 'white') updates['players.whiteId'] = null;

    // Add back to spectators if not already
    updates['spectators'] = firebase.firestore.FieldValue.arrayUnion(clientId);
    updates[`heartbeats.${clientId}`] = firebase.firestore.FieldValue.serverTimestamp();

    roomRef.update(updates).then(() => {
        playerRole = 'spectator';
        document.getElementById('my-role').textContent = '觀眾';
    }).catch(err => console.error("Switch to spec failed:", err));
}

function leaveRoom() {
    stopHeartbeat(); // 停止 heartbeat loop
    if (!roomId) return;

    const roomRef = db.collection('rooms').doc(roomId);

    // 準備一次過要 update 嘅欄位
    const updates = {};

    if (playerRole === 'black') {
        updates['players.blackId'] = null;
    } else if (playerRole === 'white') {
        updates['players.whiteId'] = null;
    } else {
        updates['spectators'] = firebase.firestore.FieldValue.arrayRemove(clientId);
    }

    // 🔑 重點：離開房間時順便刪走自己嘅 heartbeat
    updates[`heartbeats.${clientId}`] = firebase.firestore.FieldValue.delete();
    updates.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

    roomRef.update(updates).catch(err => {
        console.error('leaveRoom update failed:', err);
    });

    if (roomUnsubscribe) {
        roomUnsubscribe();
        roomUnsubscribe = null;
    }

    // Reset Local State
    roomId = null;
    playerRole = null;

    // Update UI
    showView('online-lobby');
    boardElement.innerHTML = ''; // Clear board
}

function bindRoomListener() {
    if (!roomId) return;

    roomUnsubscribe = db.collection('rooms').doc(roomId)
        .onSnapshot((doc) => {
            if (!doc.exists) {
                // Room deleted or something wrong
                return;
            }
            const data = doc.data();

            // Sync Board
            syncBoard(data.board);

            // Sync Game State
            currentPlayer = data.currentPlayer;
            gameOver = data.gameOver;

            // Update Status Text
            if (gameOver) {
                statusElement.innerHTML = `<span class="player-turn" style="color: ${currentPlayer === 'black' ? '#000' : '#888'}">${getPlayerName(currentPlayer)} 獲勝！</span>`;
            } else {
                updateStatus();
            }


            // Show "Start Game" button only if 2 players are present
            const startBtn = document.getElementById('online-start-btn');
            // Logic for showing start button or wait status could be improved, but keeping simple for now
            if (data.players.blackId && data.players.whiteId) {
                startBtn.classList.remove('hidden');
            } else {
                startBtn.classList.add('hidden');
            }

            // Update Role Buttons State
            const btnBlack = document.getElementById('btn-claim-black');
            const btnWhite = document.getElementById('btn-claim-white');

            if (data.players.blackId) {
                btnBlack.disabled = true;
                btnBlack.textContent = (data.players.blackId === clientId) ? "你是黑子" : "黑子已被佔用";
            } else {
                btnBlack.disabled = false;
                btnBlack.textContent = "成為黑子玩家";
            }

            if (data.players.whiteId) {
                btnWhite.disabled = true;
                btnWhite.textContent = (data.players.whiteId === clientId) ? "你是白子" : "白子已被佔用";
            } else {
                btnWhite.disabled = false;
                btnWhite.textContent = "成為白子玩家";
            }

        }, (error) => {
            console.error("Room listener error:", error);
        });
}

function syncBoard(remoteBoard) {
    if (!remoteBoard) return;

    const cells = document.querySelectorAll('.cell');
    if (cells.length === 0) {
        createBoard();
    }

    // Reconstruct 2D board from 1D remoteBoard
    // remoteBoard is 1D array of length 225

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const index = r * BOARD_SIZE + c;
            const val = remoteBoard[index];
            board[r][c] = val; // Update local 2D state

            const cell = document.querySelector(`.cell[data-row='${r}'][data-col='${c}']`);
            if (cell) {
                cell.innerHTML = ''; // Clear existing stone
                if (val) {
                    const stone = document.createElement('div');
                    stone.classList.add('stone', val);
                    cell.appendChild(stone);
                }
            }
        }
    }
}

function startOnlineGame() {
    if (!roomId) return;

    const roomRef = db.collection('rooms').doc(roomId);
    roomRef.update({
        board: Array(15 * 15).fill(null), // Reset to 1D array
        currentPlayer: 'black',
        gameOver: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
}

// --- Heartbeat Logic ---
let heartbeatInterval = null;

function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    // Immediate heartbeat
    sendHeartbeat();

    // Loop every 30 seconds
    heartbeatInterval = setInterval(sendHeartbeat, 30000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

function sendHeartbeat() {
    if (!roomId || !clientId) return;

    // Update simple heartbeat timestamp map
    // Using merge: true equivalent via update
    const roomRef = db.collection('rooms').doc(roomId);

    // Use dot notation to update nested field in 'heartbeats' map
    // We need to ensure the key exists.
    // Actually, 'heartbeats' is a map field. 
    // update({ ['heartbeats.' + clientId]: ... })

    const updateData = {};
    updateData[`heartbeats.${clientId}`] = firebase.firestore.FieldValue.serverTimestamp();

    roomRef.update(updateData).catch(err => {
        // Silent fail (network glitches happen)
        console.warn("Heartbeat failed:", err);
    });
}
function listenToRoomCounts() {
    ['room1', 'room2', 'room3'].forEach(rid => {
        db.collection('rooms').doc(rid).onSnapshot(doc => {
            const countSpan = document.getElementById(`${rid}-count`);
            if (!doc.exists) {
                if (countSpan) countSpan.textContent = '(0/2)';
                return;
            }

            const data = doc.data();
            const now = Date.now();
            const MAX_INACTIVE_TIME = 60000; // 60 秒 timeout

            let pCount = 0;
            const updates = {};
            let needUpdate = false;

            let blackActive = false;
            let whiteActive = false;
            let activeSpectators = data.spectators || [];

            if (data.players && data.heartbeats) {
                // ---- Black 玩家 ----
                if (data.players.blackId) {
                    const blackId = data.players.blackId;
                    const blackTs = data.heartbeats[blackId];

                    if (blackTs && blackTs.toMillis && (now - blackTs.toMillis() > MAX_INACTIVE_TIME)) {
                        // heartbeat 太舊 → 當佢斷線，清人＋清 heartbeat
                        updates['players.blackId'] = null;
                        updates[`heartbeats.${blackId}`] = firebase.firestore.FieldValue.delete();
                        needUpdate = true;
                    } else if (!blackTs) {
                        // If no heartbeat found, give a grace period of 5 seconds (maybe they just joined)
                        // Actually, transaction sets it. If it's missing, it's a desync.
                        // But let's be safe: don't auto-kick immediately if data.heartbeats is present but key is missing
                        // UNLESS we are sure. For now, strict: if map exists but key doesn't, kick.
                        updates['players.blackId'] = null;
                        needUpdate = true;
                    } else {
                        blackActive = true;
                        pCount++;
                    }
                }

                // ---- White 玩家 ----
                if (data.players.whiteId) {
                    const whiteId = data.players.whiteId;
                    const whiteTs = data.heartbeats[whiteId];

                    if (whiteTs && whiteTs.toMillis && (now - whiteTs.toMillis() > MAX_INACTIVE_TIME)) {
                        updates['players.whiteId'] = null;
                        updates[`heartbeats.${whiteId}`] = firebase.firestore.FieldValue.delete();
                        needUpdate = true;
                    } else if (!whiteTs) {
                        updates['players.whiteId'] = null;
                        needUpdate = true;
                    } else {
                        whiteActive = true;
                        pCount++;
                    }
                }

                // ---- 觀戰者 ----
                if (data.spectators && data.spectators.length > 0) {
                    activeSpectators = [];
                    data.spectators.forEach(specId => {
                        const specTs = data.heartbeats[specId];
                        if (specTs && specTs.toMillis && (now - specTs.toMillis() <= MAX_INACTIVE_TIME)) {
                            activeSpectators.push(specId); // 仲活躍
                        } else {
                            // timeout spectator，刪 heartbeat
                            updates[`heartbeats.${specId}`] = firebase.firestore.FieldValue.delete();
                            needUpdate = true;
                        }
                    });

                    if (activeSpectators.length !== data.spectators.length) {
                        updates['spectators'] = activeSpectators;
                        needUpdate = true;
                    }
                }
            } else {
                // 冇 heartbeats map 嘅 fallback（基本上只係初始化時先會見到）
                if (data.players && data.players.blackId) {
                    blackActive = true;
                    pCount++;
                }
                if (data.players && data.players.whiteId) {
                    whiteActive = true;
                    pCount++;
                }
            }

            const totalPlayers = (blackActive ? 1 : 0) + (whiteActive ? 1 : 0);
            const totalSpectators = activeSpectators.length;

            // 🔁 如果房間完全冇人（冇玩家＋冇觀戰）→ 自動 reset 棋局
            if (totalPlayers === 0 && totalSpectators === 0) {
                updates.board = Array(15 * 15).fill(null); // 清棋盤
                updates.currentPlayer = 'black';
                updates.gameOver = false;
                updates.heartbeats = {}; // 心跳 map 清空
                updates.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
                needUpdate = true;
            }

            if (needUpdate) {
                db.collection('rooms').doc(rid).update(updates).catch(console.error);
            }

            if (countSpan) {
                countSpan.textContent = `(${pCount}/2)`;
            }
        });
    });
}

// Start listening for room counts immediately
listenToRoomCounts();

// Graceful exit
window.addEventListener('beforeunload', () => {
    if (mode === 'online' && roomId) {
        // Try to leave synchronously? 
        // Navigator.sendBeacon is better but Firestore doesn't support it directly easily.
        // We will just try best effort leaveRoom.
        leaveRoom();
    }
});

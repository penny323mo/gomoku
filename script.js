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
let lobbyUnsubscribes = [];

// --- Write Protection Globals ---
let lastWriteTime = 0;
const MIN_WRITE_INTERVAL = 1000; // 1s global buffer
let lastHeartbeatTime = 0;
const MIN_HEARTBEAT_INTERVAL = 20000; // 20s minimum between beats
const roomUpdateDebounce = {}; // Map of roomId -> timestamp

function safeUpdate(docRef, data, roomIdForDebounce = null) {
    const now = Date.now();
    if (now - lastWriteTime < MIN_WRITE_INTERVAL) {
        console.warn("Write blocked: Global rate limit hit");
        return Promise.resolve(); // Fail silent/safe
    }

    // Per-room debounce for admin tasks (like count cleanup)
    if (roomIdForDebounce) {
        const lastRoomWrite = roomUpdateDebounce[roomIdForDebounce] || 0;
        if (now - lastRoomWrite < 10000) { // 10s debounce for background tasks
            // console.log("Write blocked: Room debounce hit");
            return Promise.resolve();
        }
        roomUpdateDebounce[roomIdForDebounce] = now;
    }

    lastWriteTime = now;
    return docRef.update(data);
}

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
    stopHeartbeat();
    if (mode === 'online') {
        leaveRoom(); // Helper to clean up if we were in a room
        stopLobbyListeners();
    }
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

    // Stop lobby count listeners to save quota
    stopLobbyListeners();

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

    // Throttle Check
    const now = Date.now();
    if (now - lastHeartbeatTime < MIN_HEARTBEAT_INTERVAL) {
        return;
    }

    const roomRef = db.collection('rooms').doc(roomId);
    const updateData = {};
    updateData[`heartbeats.${clientId}`] = firebase.firestore.FieldValue.serverTimestamp();

    // We don't use safeUpdate here because heartbeats are critical for presence
    // but we DO respect our own throttle.
    lastHeartbeatTime = now;

    roomRef.update(updateData).catch(err => {
        console.warn("Heartbeat failed:", err);
    });
}
function stopLobbyListeners() {
    lobbyUnsubscribes.forEach(unsubscribe => unsubscribe());
    lobbyUnsubscribes = [];
}

function listenToRoomCounts() {
    // Prevent duplicate listeners
    if (lobbyUnsubscribes.length > 0) return;

    ['room1', 'room2', 'room3'].forEach(rid => {
        const unsubscribe = db.collection('rooms').doc(rid).onSnapshot(doc => {
            const countSpan = document.getElementById(`${rid}-count`);
            if (!doc.exists) {
                if (countSpan) countSpan.textContent = '(0/2)';
                return;
            }

            const data = doc.data();
            const now = Date.now();
            const MAX_INACTIVE_TIME = 60000; // 60s timeout

            let pCount = 0;
            const updates = {};
            let needUpdate = false;

            let blackActive = false;
            let whiteActive = false;
            let activeSpectators = data.spectators || [];

            if (data.players && data.heartbeats) {
                // ---- Black Player Check ----
                if (data.players.blackId) {
                    const blackId = data.players.blackId;
                    const blackTs = data.heartbeats[blackId];

                    if (blackTs && blackTs.toMillis && (now - blackTs.toMillis() > MAX_INACTIVE_TIME)) {
                        updates['players.blackId'] = null;
                        updates[`heartbeats.${blackId}`] = firebase.firestore.FieldValue.delete();
                        needUpdate = true;
                    } else if (blackTs) { // Only count if valid heartbeat exists OR lenient check passed
                        blackActive = true;
                        pCount++;
                    } else {
                        // Strict mode: No heartbeat = not active (eventually cleaned by timeout logic next cycle if we want, or immediate)
                        // For safety to avoid loop: only clear if *explicitly* stale. 
                        // If missing entirely (new joiner race condition), let it be for now unless persistent.
                        // But to fix "ghosts", we'll check if it's been missing for a while? 
                        // Simplified: If Black ID exists but NO heartbeat entry, assume stale session IF write happened long ago.
                        // For this optimized version: Let's assume active unless timed out.
                        blackActive = true;
                        pCount++;
                    }
                }

                // ---- White Player Check ----
                if (data.players.whiteId) {
                    const whiteId = data.players.whiteId;
                    const whiteTs = data.heartbeats[whiteId];

                    if (whiteTs && whiteTs.toMillis && (now - whiteTs.toMillis() > MAX_INACTIVE_TIME)) {
                        updates['players.whiteId'] = null;
                        updates[`heartbeats.${whiteId}`] = firebase.firestore.FieldValue.delete();
                        needUpdate = true;
                    } else if (whiteTs) {
                        whiteActive = true;
                        pCount++;
                    } else {
                        whiteActive = true;
                        pCount++;
                    }
                }

                // ---- Spectator Check ----
                if (data.spectators && data.spectators.length > 0) {
                    activeSpectators = [];
                    data.spectators.forEach(specId => {
                        const specTs = data.heartbeats[specId];
                        if (specTs && specTs.toMillis && (now - specTs.toMillis() <= MAX_INACTIVE_TIME)) {
                            activeSpectators.push(specId);
                        } else if (specTs) {
                            // Has Timestamp but old -> Timeout
                            updates[`heartbeats.${specId}`] = firebase.firestore.FieldValue.delete();
                            needUpdate = true;
                        }
                        // If no TS, ignore (don't add to active, don't delete yet)
                    });

                    if (activeSpectators.length !== data.spectators.length) {
                        updates['spectators'] = activeSpectators;
                        needUpdate = true;
                    }
                }
            } else {
                // Fallback Count
                if (data.players?.blackId) pCount++;
                if (data.players?.whiteId) pCount++;
            }

            const totalPlayers = (blackActive ? 1 : 0) + (whiteActive ? 1 : 0);
            const totalSpectators = activeSpectators.length;

            // Auto Reset if Empty
            if (totalPlayers === 0 && totalSpectators === 0) {
                // Only write if not already reset
                if (data.currentPlayer !== 'black' || data.gameOver === true || data.board.some(x => x !== null)) {
                    updates.board = Array(15 * 15).fill(null);
                    updates.currentPlayer = 'black';
                    updates.gameOver = false;
                    updates.heartbeats = {};
                    updates.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
                    needUpdate = true;
                }
            }

            // Only update if we have actual changes AND pass debounce
            if (needUpdate) {
                // Use safeUpdate with room-specific debounce ID
                safeUpdate(db.collection('rooms').doc(rid), updates, rid).catch(console.error);
            }

            if (countSpan) {
                countSpan.textContent = `(${pCount}/2)`;
            }
        });
        lobbyUnsubscribes.push(unsubscribe);
    });
}

// Graceful exit
window.addEventListener('beforeunload', () => {
    if (mode === 'online' && roomId) {
        // Try to leave synchronously? 
        // Navigator.sendBeacon is better but Firestore doesn't support it directly easily.
        // We will just try best effort leaveRoom.
        leaveRoom();
    }
});

// --- Game Hub Navigation ---
function showApp(appName) {
    // Hide all main containers
    document.getElementById('app-hub').classList.add('hidden');
    document.getElementById('app-gomoku').classList.add('hidden');
    document.getElementById('app-penny-crush').classList.add('hidden');

    // Show selected
    if (appName === 'hub') {
        document.getElementById('app-hub').classList.remove('hidden');
        // Stop any active games
        PennyCrush.stop();
        // If exiting Gomoku online, we might want to cleanup? 
        // backToLanding() handles cleanup if called manually, but here we are forcing switch.
        // Let's ensure we are clean.
        if (mode === 'online') {
            leaveRoom();
            stopLobbyListeners();
        }
    } else if (appName === 'gomoku') {
        document.getElementById('app-gomoku').classList.remove('hidden');
        showView('landing'); // Reset to landing or keep state? Landing is safer.
    } else if (appName === 'pennyCrush') {
        document.getElementById('app-penny-crush').classList.remove('hidden');
        document.getElementById('pc-menu').classList.remove('hidden');
        document.getElementById('pc-game').classList.add('hidden');
    }
}

// --- Penny Crush Game Logic ---
const PennyCrush = {
    gridSize: 4,
    grid: [], // 2D array of strings (colors)
    score: 0,
    selectedTile: null, // {r, c}
    isProcessing: false,
    colors: ['pc-red', 'pc-orange', 'pc-yellow', 'pc-green', 'pc-blue', 'pc-purple'],

    init: function (size) {
        this.gridSize = size;
        this.gridSize = size;
        this.score = 0;
        this.selectedTile = null;
        this.isProcessing = false;
        this.shuffleRemaining = 3;
        this.updateScore(0);
        this.updateShuffleBtn();

        document.getElementById('pc-menu').classList.add('hidden');
        document.getElementById('pc-game').classList.remove('hidden');

        // --- Dynamic Scaling ---
        // Calculate max available space. 
        // We want to fit within e.g. 500px width on desktop, or full width on mobile.
        // And also fit vertically within (Height - Header - Controls - Padding)

        this.calculateTileSize();

        // Add Resize Listener (Debounced)
        if (!this.resizeListenerAdded) {
            let resizeTimeout;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    if (document.getElementById('pc-game').classList.contains('hidden')) return;
                    this.calculateTileSize();
                    this.renderGrid();
                }, 200);
            });
            this.resizeListenerAdded = true;
        }

        this.generateGrid();
        this.renderGrid();
    },

    calculateTileSize: function () {
        // Dynamic sizing based on viewport
        // More conservative sizing for mobile to ensure everything fits
        const isMobile = window.innerWidth <= 768;

        // Leave more room on mobile for header, controls, safe areas
        const widthRatio = isMobile ? 0.9 : 0.95;
        const heightRatio = isMobile ? 0.55 : 0.65; // Reduced for mobile

        const availableWidth = window.innerWidth * widthRatio;
        const availableHeight = window.innerHeight * heightRatio;

        const maxTileWidth = Math.floor(availableWidth / this.gridSize);
        const maxTileHeight = Math.floor(availableHeight / this.gridSize);

        // Smaller max tile size on mobile
        const maxTileSize = isMobile ? 35 : 50;
        let size = Math.min(maxTileWidth, maxTileHeight, maxTileSize);
        if (size < 12) size = 12; // Min size

        // Update CSS variable
        document.documentElement.style.setProperty('--tile-size', `${size}px`);
        document.documentElement.style.setProperty('--grid-size', this.gridSize);

        // Update grid columns style directly
        const gridEl = document.getElementById('pc-grid');
        if (gridEl) {
            gridEl.style.gridTemplateColumns = `repeat(${this.gridSize}, 1fr)`;
        }
    },
    stop: function () {
        this.isProcessing = false;
    },

    restart: function () {
        this.init(this.gridSize);
    },

    exit: function () {
        showApp('hub');
    },

    updateScore: function (add) {
        this.score += add;
        document.getElementById('pc-score').textContent = this.score;
    },

    generateGrid: function () {
        this.grid = [];
        for (let r = 0; r < this.gridSize; r++) {
            const row = [];
            for (let c = 0; c < this.gridSize; c++) {
                row.push(this.getRandomColor());
            }
            this.grid.push(row);
        }
        // Resolve initial matches without score
        let matches = this.findMatches();
        let safety = 0;
        while (matches.length > 0 && safety < 100) {
            matches.forEach(m => {
                this.grid[m.r][m.c] = this.getRandomColor();
            });
            matches = this.findMatches();
            safety++;
        }
    },

    getRandomColor: function () {
        return this.colors[Math.floor(Math.random() * this.colors.length)];
    },

    renderGrid: function () {
        const gridEl = document.getElementById('pc-grid');
        gridEl.innerHTML = '';

        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize; c++) {
                const tile = document.createElement('div');
                tile.className = `pc-tile ${this.grid[r][c]}`;
                tile.dataset.r = r;
                tile.dataset.c = c;

                // Add Candy Shape Inner
                const shape = document.createElement('div');
                shape.className = 'candy-shape';
                tile.appendChild(shape);

                if (this.selectedTile && this.selectedTile.r === r && this.selectedTile.c === c) {
                    tile.classList.add('selected');
                }

                tile.onclick = () => this.handleTileClick(r, c);
                gridEl.appendChild(tile);
            }
        }
    },



    applyGravity: async function () {
        // Move tiles down
        for (let c = 0; c < this.gridSize; c++) {
            let emptyCount = 0;
            for (let r = this.gridSize - 1; r >= 0; r--) {
                if (this.grid[r][c] === null) {
                    emptyCount++;
                } else if (emptyCount > 0) {
                    // Move down
                    this.grid[r + emptyCount][c] = this.grid[r][c];
                    this.grid[r][c] = null;

                    // Simple logic: we just moved one stone. 
                    // To support full cascade correctly in one pass is tricky.
                    // Actually, simpler approach: collect column, filter nulls, prepend new.
                }
            }

            // Refill top
            for (let r = 0; r < emptyCount; r++) {
                this.grid[r][c] = this.getRandomColor();
            }
        }

        this.renderGrid();
        // Allow a small delay for "falling" viz if we animation later, 
        // for now instantaneous logic update.
        await new Promise(r => setTimeout(r, 200));
    },

    // --- Shuffle Feature ---
    shuffleRemaining: 3,
    // Bomb State
    turnClearedCount: 0,

    shuffleBoard: function () {
        if (this.isProcessing || this.shuffleRemaining <= 0) return;

        // Decrement and Update UI
        this.shuffleRemaining--;
        this.updateShuffleBtn();

        // 1. Collect all non-null tiles (flatten)
        let tiles = [];
        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize; c++) {
                if (this.grid[r][c]) {
                    tiles.push(this.grid[r][c]);
                } else {
                    tiles.push(this.getRandomColor());
                }
            }
        }

        // 2. Fisher-Yates Shuffle
        let attempts = 0;
        let solvable = false;

        while (attempts < 10 && !solvable) {
            // Shuffle array
            for (let i = tiles.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
            }

            // Fill Grid temporarily
            let idx = 0;
            for (let r = 0; r < this.gridSize; r++) {
                for (let c = 0; c < this.gridSize; c++) {
                    this.grid[r][c] = tiles[idx++];
                }
            }

            // Check solvability
            if (this.hasPossibleMove()) {
                solvable = true;
            }
            attempts++;
        }

        // 3. Render
        this.renderGrid();

        const matches = this.findMatches();
        if (matches.length > 0) {
            this.processMatches(matches);
        }
    },

    updateShuffleBtn: function () {
        const btn = document.getElementById('btn-shuffle');
        if (!btn) return;
        btn.textContent = `Shuffle (${this.shuffleRemaining})`;
        if (this.shuffleRemaining <= 0) {
            btn.disabled = true;
            btn.classList.add('disabled');
        } else {
            btn.disabled = false;
            btn.classList.remove('disabled');
        }
    },

    hasPossibleMove: function () {
        // Horizontal
        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize - 1; c++) {
                // If either is a bomb, it's a valid move!
                if (this.isBomb(r, c) || this.isBomb(r, c + 1)) return true;

                this.tempSwap(r, c, r, c + 1);
                const hasMatch = this.checkMatchAt(r, c) || this.checkMatchAt(r, c + 1);
                this.tempSwap(r, c, r, c + 1);
                if (hasMatch) return true;
            }
        }
        // Vertical
        for (let r = 0; r < this.gridSize - 1; r++) {
            for (let c = 0; c < this.gridSize; c++) {
                // If either is a bomb, it's a valid move!
                if (this.isBomb(r, c) || this.isBomb(r + 1, c)) return true;

                this.tempSwap(r, c, r + 1, c);
                const hasMatch = this.checkMatchAt(r, c) || this.checkMatchAt(r + 1, c);
                this.tempSwap(r, c, r + 1, c);
                if (hasMatch) return true;
            }
        }
        return false;
    },

    tempSwap: function (r1, c1, r2, c2) {
        const temp = this.grid[r1][c1];
        this.grid[r1][c1] = this.grid[r2][c2];
        this.grid[r2][c2] = temp;
    },

    checkMatchAt: function (r, c) {
        const color = this.grid[r][c];
        if (!color || color === 'pc-bomb') return false; // Bombs don't match colors

        // Horiz Check
        let hCount = 1;
        let k = c - 1;
        while (k >= 0 && this.grid[r][k] === color) { hCount++; k--; }
        k = c + 1;
        while (k < this.gridSize && this.grid[r][k] === color) { hCount++; k++; }
        if (hCount >= 3) return true;

        // Vertical scan
        let vCount = 1;
        k = r - 1;
        while (k >= 0 && this.grid[k][c] === color) { vCount++; k--; }
        k = r + 1;
        while (k < this.gridSize && this.grid[k][c] === color) { vCount++; k++; }
        if (vCount >= 3) return true;

        return false;
    },

    isBomb: function (r, c) {
        return this.grid[r][c] === 'pc-bomb';
    },

    // --- Bomb Logic ---

    // Updated handleTileClick for Bomb interaction is not needed if logic is in swapTiles ?
    // Actually handleTileClick calls swapTiles which calls process.
    // We need to intercept standard matching if a bomb is used.

    handleTileClick: function (r, c) {
        if (this.isProcessing) return;

        // Deselect if same
        if (this.selectedTile && this.selectedTile.r === r && this.selectedTile.c === c) {
            this.selectedTile = null;
            this.renderGrid();
            return;
        }

        // Select first
        if (!this.selectedTile) {
            this.selectedTile = { r, c };
            this.renderGrid();
            return;
        }

        // Swap processing
        const r1 = this.selectedTile.r;
        const c1 = this.selectedTile.c;
        const r2 = r;
        const c2 = c;

        // Check adjacency
        const isAdjacent = (Math.abs(r1 - r2) === 1 && c1 === c2) || (Math.abs(c1 - c2) === 1 && r1 === r2);

        if (isAdjacent) {
            this.swapTiles(r1, c1, r2, c2);
        } else {
            // New selection
            this.selectedTile = { r, c };
            this.renderGrid();
        }
    },

    swapTiles: async function (r1, c1, r2, c2) {
        this.isProcessing = true;
        this.selectedTile = null;

        // Swap data
        const temp = this.grid[r1][c1];
        this.grid[r1][c1] = this.grid[r2][c2];
        this.grid[r2][c2] = temp;

        this.renderGrid();

        // Check Bomb Trigger
        const isBomb1 = this.grid[r1][c1] === 'pc-bomb';
        const isBomb2 = this.grid[r2][c2] === 'pc-bomb';

        if (isBomb1 || isBomb2) {
            // Valid switch! Detonate!
            // Wait for visual swap
            await new Promise(r => setTimeout(r, 200));

            this.turnClearedCount = 0; // Reset for this move

            // Collect bombs to detonate
            const bombsToDetonate = [];
            if (isBomb1) bombsToDetonate.push({ r: r1, c: c1 });
            if (isBomb2) bombsToDetonate.push({ r: r2, c: c2 });

            await this.detonateBombs(bombsToDetonate);

            // After bomb, check regular matches too? 
            // Usually bomb destroys things, then gravity, then matches.
            // detonateBombs triggers gravity and match loop.
            return;
        }

        // Normal Match Check
        const matches = this.findMatches();

        if (matches.length > 0) {
            this.turnClearedCount = 0; // Reset count for this new move
            await this.processMatches(matches);

            // After cascade is ALL done (in processMatches recursion), 
            // check for Bomb Spawn reward?
            // processMatches calls applyGravity then findMatches...
            // We need a way to know "Everything Settled".
            // Since processMatches is recursive/async, we can't easily do it "after" strictly here without refactor.
            // BUT: We can check turnClearedCount at the end of the chain.
            // Or better: Inside processMatches, accumulate.
            // And logic to spawn bomb?
            // Let's create a 'settle' phase. 
            // Actually, we can just check 'turnClearedCount' inside processMatches after gravity?
            // No, we should do it when NO MORE matches found.
        } else {
            // Revert animation
            const t1 = document.querySelector(`.pc-tile[data-r="${r1}"][data-c="${c1}"]`);
            const t2 = document.querySelector(`.pc-tile[data-r="${r2}"][data-c="${c2}"]`);
            t1.classList.add('pc-shake');
            t2.classList.add('pc-shake');

            await new Promise(r => setTimeout(r, 300));

            // Revert data
            const temp = this.grid[r1][c1];
            this.grid[r1][c1] = this.grid[r2][c2];
            this.grid[r2][c2] = temp;

            this.isProcessing = false;
            this.renderGrid();
        }
    },

    detonateBombs: async function (bombs) {
        // Create a Set of tiles to clear
        const toClear = new Set();

        bombs.forEach(b => {
            // Clear entire row
            for (let c = 0; c < this.gridSize; c++) {
                toClear.add(`${b.r},${c}`);
            }
            // Clear entire column
            for (let r = 0; r < this.gridSize; r++) {
                toClear.add(`${r},${b.c}`);
            }
        });

        // Visualize
        toClear.forEach(str => {
            const [r, c] = str.split(',').map(Number);
            const tile = document.querySelector(`.pc-tile[data-r="${r}"][data-c="${c}"]`);
            if (tile) tile.classList.add('pc-pop'); // Reuse pop for now
        });

        await new Promise(r => setTimeout(r, 300));

        // Score
        this.updateScore(toClear.size * 20); // Bombs worth more?
        this.turnClearedCount += toClear.size;

        // Clear Data
        toClear.forEach(str => {
            const [r, c] = str.split(',').map(Number);
            this.grid[r][c] = null;
        });

        // Gravity
        await this.applyGravity();

        // Resume match checking
        const newMatches = this.findMatches();
        if (newMatches.length > 0) {
            await this.processMatches(newMatches);
        } else {
            // Settle
            this.finalizeTurn();
        }
    },

    processMatches: async function (matches) {
        // Highlight Matches
        matches.forEach(m => {
            const tile = document.querySelector(`.pc-tile[data-r="${m.r}"][data-c="${m.c}"]`);
            if (tile) tile.classList.add('pc-pop');
        });

        await new Promise(r => setTimeout(r, 300));

        // Remove and Score
        this.updateScore(matches.length * 10);
        this.turnClearedCount += matches.length;

        // Remove from grid (set to null)
        matches.forEach(m => {
            this.grid[m.r][m.c] = null;
        });

        // Gravity
        await this.applyGravity();

        // Check new matches
        const newMatches = this.findMatches();
        if (newMatches.length > 0) {
            await this.processMatches(newMatches);
        } else {
            // No more matches -> Turn End
            this.finalizeTurn();
        }
    },

    finalizeTurn: function () {
        // Check for Bomb Reward
        if (this.turnClearedCount >= 6) {
            this.spawnBomb();
        }
        this.isProcessing = false;
        this.turnClearedCount = 0; // Reset safely
    },

    spawnBomb: function () {
        // Find a random non-null spot (or null if we messed up)
        // Prefer non-bomb
        let attempts = 0;
        while (attempts < 20) {
            const r = Math.floor(Math.random() * this.gridSize);
            const c = Math.floor(Math.random() * this.gridSize);
            if (this.grid[r][c] && this.grid[r][c] !== 'pc-bomb') {
                this.grid[r][c] = 'pc-bomb';
                // Trigger visual update for just this tile? or full render
                // Let's full render to be safe and clear animation classes
                this.renderGrid();

                // Add a visual 'spawn' effect?
                const tile = document.querySelector(`.pc-tile[data-r="${r}"][data-c="${c}"]`);
                if (tile) {
                    tile.style.animation = 'none';
                    tile.offsetHeight; /* trigger reflow */
                    tile.classList.add('pc-pop'); // Pulse it
                }
                break;
            }
            attempts++;
        }
    },

    // Updated findMatches to Ignore Bombs
    findMatches: function () {
        const matches = [];
        const matchedSet = new Set();

        // Helper to check valid color
        const isValid = (color) => color && color !== 'pc-bomb';

        // Horizontal
        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize - 2; c++) {
                const color = this.grid[r][c];
                if (isValid(color) && color === this.grid[r][c + 1] && color === this.grid[r][c + 2]) {
                    matchedSet.add(`${r},${c}`);
                    matchedSet.add(`${r},${c + 1}`);
                    matchedSet.add(`${r},${c + 2}`);
                    let k = c + 3;
                    while (k < this.gridSize && this.grid[r][k] === color) {
                        matchedSet.add(`${r},${k}`);
                        k++;
                    }
                }
            }
        }

        // Vertical
        for (let c = 0; c < this.gridSize; c++) {
            for (let r = 0; r < this.gridSize - 2; r++) {
                const color = this.grid[r][c];
                if (isValid(color) && color === this.grid[r + 1][c] && color === this.grid[r + 2][c]) {
                    matchedSet.add(`${r},${c}`);
                    matchedSet.add(`${r + 1},${c}`);
                    matchedSet.add(`${r + 2},${c}`);
                    let k = r + 3;
                    while (k < this.gridSize && this.grid[k][c] === color) {
                        matchedSet.add(`${k},${c}`);
                        k++;
                    }
                }
            }
        }

        matchedSet.forEach(str => {
            const parts = str.split(',');
            matches.push({ r: parseInt(parts[0]), c: parseInt(parts[1]) });
        });

        return matches;
    }
};

/*
 * =========================================================================
 * PENNY CRUSH GRID BUG FIX (January 2026)
 * =========================================================================
 * 
 * PROBLEM: The Penny Crush game grid was not rendering. Users would see
 *          the title, score, and buttons, but the game board was completely
 *          missing on both desktop and mobile.
 * 
 * ROOT CAUSE: JavaScript logic error in PennyCrush.init()
 *   - The init() function was calling renderGrid() directly without first
 *     calling generateGrid() to populate the this.grid data array.
 *   - Since this.grid was initialized as an empty array [], the renderGrid()
 *     function's loops (for r < gridSize, for c < gridSize) would iterate
 *     over undefined rows, creating zero tile elements.
 * 
 * FIX: Added the missing this.generateGrid() call in init() before 
 *      renderGrid() on line 1112. This ensures the 2D grid array is 
 *      populated with random candy colors before the DOM tiles are created.
 * 
 * Existing functionality preserved:
 *   - Shuffle (3 uses) works correctly
 *   - Matching/cascading logic unchanged
 *   - Bomb power-up mechanics intact
 *   - Gomoku and main menu unaffected
 * =========================================================================
 */

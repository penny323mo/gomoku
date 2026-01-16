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
let mode = 'ai'; // 'ai' or 'online'
let roomId = null;
let playerRole = null; // 'black', 'white', 'spectator', or null
let roomUnsubscribe = null;

// --- Client ID Logic ---
let clientId = localStorage.getItem('gomoku_clientId');
if (!clientId) {
    clientId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('gomoku_clientId', clientId);
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
            if (data.board[row][col] !== null) throw "Cell occupied";

            // Prepare new board state
            const newBoard = data.board; // deep copy used by Firestore? No, but we modify it.
            // Firestore data calls return JS objects. modifying data.board modifies the object.
            // We need to be careful? Actually it's fine to modify 'data' object if we write it back.
            newBoard[row][col] = playerRole;

            const isWin = checkWin(row, col, playerRole, true, newBoard); // usage of helper with new board

            const updates = {
                board: newBoard,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            if (isWin) {
                updates.gameOver = true;
                // wins are handled by update listener
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

function setMode(newMode) {
    mode = newMode;
    isVsAI = (mode === 'ai');

    // Update Mode Buttons
    document.getElementById('mode-ai').classList.toggle('active', mode === 'ai');
    document.getElementById('mode-online').classList.toggle('active', mode === 'online');

    // Toggle Sections
    const aiControls = document.getElementById('ai-controls');
    const onlineControls = document.getElementById('online-global-controls');
    const resetBtn = document.getElementById('reset-btn');

    if (mode === 'ai') {
        aiControls.classList.remove('hidden');
        onlineControls.classList.add('hidden');
        resetBtn.style.display = 'inline-block';
        if (roomUnsubscribe) leaveRoom(); // Auto leave if switching back to AI
        resetGame(); // Reset local AI game
    } else {
        aiControls.classList.add('hidden');
        onlineControls.classList.remove('hidden');
        resetBtn.style.display = 'none'; // Hide local reset button in online mode lobby
        // Reset board for clean state
        boardElement.innerHTML = '';
        statusElement.innerHTML = '請選擇房間加入';
    }
}

function joinRoom(selectedRoomId) {
    if (roomId === selectedRoomId) return; // Already in this room

    // Leave previous room if any
    if (roomUnsubscribe) {
        roomUnsubscribe();
        roomUnsubscribe = null;
    }

    roomId = selectedRoomId;

    // Show room info
    document.getElementById('room-list').classList.add('hidden');
    document.getElementById('room-info').classList.remove('hidden');
    document.getElementById('current-room-id').textContent = roomId;

    const roomRef = db.collection('rooms').doc(roomId);

    db.runTransaction(async (transaction) => {
        const doc = await transaction.get(roomRef);

        if (!doc.exists) {
            // Create room if not exists
            transaction.set(roomRef, {
                board: Array(15).fill(null).map(() => Array(15).fill(null)),
                currentPlayer: 'black',
                gameOver: false,
                players: { blackId: null, whiteId: null },
                spectators: [],
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            return { role: 'black' }; // First joiner becomes black
        }

        const data = doc.data();
        let assignedRole = 'spectator';

        if (data.players.blackId === clientId || data.players.blackId === null) {
            assignedRole = 'black';
            transaction.update(roomRef, { 'players.blackId': clientId });
        } else if (data.players.whiteId === clientId || data.players.whiteId === null) {
            assignedRole = 'white';
            transaction.update(roomRef, { 'players.whiteId': clientId });
        } else {
            // Add to spectators if not already there
            if (!data.spectators.includes(clientId)) {
                transaction.update(roomRef, {
                    spectators: firebase.firestore.FieldValue.arrayUnion(clientId)
                });
            }
        }

        return { role: assignedRole };
    }).then((result) => {
        playerRole = result.role;
        document.getElementById('my-role').textContent = getPlayerName(playerRole) || '觀眾';
        bindRoomListener();
    }).catch((error) => {
        console.error("Join room failed: ", error);
        alert("加入了房間失敗，請稍後再試。");
        setMode('online'); // Reset UI
    });
}

function leaveRoom() {
    if (!roomId) return;

    const roomRef = db.collection('rooms').doc(roomId);

    // Attempt to remove self from room
    if (playerRole === 'black') {
        roomRef.update({ 'players.blackId': null });
    } else if (playerRole === 'white') {
        roomRef.update({ 'players.whiteId': null });
    } else {
        roomRef.update({
            spectators: firebase.firestore.FieldValue.arrayRemove(clientId)
        });
    }

    if (roomUnsubscribe) {
        roomUnsubscribe();
        roomUnsubscribe = null;
    }

    // Reset Local State
    roomId = null;
    playerRole = null;

    // Update UI
    document.getElementById('room-info').classList.add('hidden');
    document.getElementById('room-list').classList.remove('hidden');
    statusElement.innerHTML = '請選擇房間加入';
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
            if (data.players.blackId && data.players.whiteId) {
                startBtn.classList.remove('hidden');
            } else {
                startBtn.classList.add('hidden');
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

    board = remoteBoard; // Update local data reference

    // Re-render stones
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const val = board[r][c];
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
        board: Array(15).fill(null).map(() => Array(15).fill(null)),
        currentPlayer: 'black',
        gameOver: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
}

function listenToRoomCounts() {
    ['room1', 'room2', 'room3'].forEach(rid => {
        db.collection('rooms').doc(rid).onSnapshot(doc => {
            const countSpan = document.getElementById(`${rid}-count`);
            if (countSpan) {
                if (doc.exists) {
                    const data = doc.data();
                    let pCount = 0;
                    if (data.players && data.players.blackId) pCount++;
                    if (data.players && data.players.whiteId) pCount++;
                    countSpan.textContent = `(${pCount}/2)`;
                } else {
                    countSpan.textContent = `(0/2)`;
                }
            }
        });
    });
}

// Start listening for room counts immediately
listenToRoomCounts();

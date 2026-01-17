// Initialize Supabase (Wrapped in try-catch for robustness)
const SUPABASE_URL = "https://djbhipofzbonxfqriovi.supabase.co";
const SUPABASE_ANON_KEY = "sb-publishable-DX7aNwHHI7tb6RUiWWe0qg_qPzuLcld";

let supabase = null;
try {
    if (window.supabase) {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } else {
        console.warn("Supabase SDK not found. Online modes will be unavailable.");
    }
} catch (e) {
    console.error("Supabase Init Failed:", e);
}

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
let mode = null; // 'ai' or 'online'
let roomId = null; // actually the channel/room code (e.g. 'room1')
let roomRecordId = null; // the UUID from Supabase 'rooms' table
let playerRole = null; // 'black', 'white', 'spectator'
let roomChannel = null;

// --- Write Protection Globals ---
let lastWriteTime = 0;
const MIN_WRITE_INTERVAL = 500; // 0.5s buffer for Supabase writes

// --- Client ID Logic ---
let clientId = localStorage.getItem('gomoku_clientId');
if (!clientId) {
    clientId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('gomoku_clientId', clientId);
}

/* Supabase logic integrated below */

// --- Client ID Logic ---
// clientId is already defined above, reusing it.
if (!localStorage.getItem('gomoku_clientId')) {
    localStorage.setItem('gomoku_clientId', Math.random().toString(36).substring(2, 15));
}
// Ensure global clientId is set if not already
if (!clientId) clientId = localStorage.getItem('gomoku_clientId');

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
        showView('online-lobby');
        isVsAI = false;
        // listenToRoomCounts removed
    }
}

function backToLanding() {
    // stopHeartbeat removed
    if (mode === 'online') {
        leaveRoom(); // Helper to clean up if we were in a room
        // stopLobbyListeners removed
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

        // 1. Broadcast Move
        broadcastMove(row, col, playerRole);

        // 2. Play locally immediately (optimistic UI)
        placeStone(row, col, playerRole);
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
            // stopLobbyListeners removed
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
    grid: [], // 2D array of strings (colors or special tiles)
    score: 0,
    selectedTile: null, // {r, c}
    isProcessing: false,
    // Updated to use 5 character types mapped to images
    colors: ['pc-char-1', 'pc-char-2', 'pc-char-3', 'pc-char-4', 'pc-char-5'],

    // Special tile types
    specialTiles: ['pc-bomb', 'pc-row-bomb', 'pc-col-bomb', 'pc-rainbow'],

    // Safety caps for special spawns per move
    MAX_BOMBS_PER_TURN: 2,
    MAX_RAINBOWS_PER_TURN: 1,
    bombsSpawnedThisTurn: 0,
    rainbowsSpawnedThisTurn: 0,
    isPlayerInitiatedTurn: false, // Track if turn came from player swap

    // Combo system
    comboCount: 0,

    // Item tools
    cleanOneRemaining: 3,
    forcedSwapRemaining: 3,
    activeToolMode: null, // 'cleanOne' | 'forcedSwap' | null

    init: function (size) {
        this.gridSize = size;
        this.score = 0;
        this.selectedTile = null;
        this.isProcessing = false;
        this.shuffleRemaining = 3;
        this.comboCount = 0;
        this.cleanOneRemaining = 3;
        this.forcedSwapRemaining = 3;
        this.activeToolMode = null;

        this.updateScore(0);
        this.updateShuffleBtn();
        this.updateToolButtons();

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
        // Dynamic sizing based on container width
        const container = document.querySelector('.penny-container');

        // Get available width from container or fallback
        // Reduce padding to absolute minimum for "full" look
        const containerWidth = container ? container.clientWidth : window.innerWidth;
        const screenHeight = window.innerHeight;
        const isMobile = window.innerWidth <= 480;

        // Minimal gap and padding for dense look
        const gapSize = isMobile ? 1 : 1.5;
        const gridPadding = isMobile ? 8 : 12; // Tighter padding

        // Calculate tile size
        const totalGaps = (this.gridSize - 1) * gapSize;
        const availableWidth = containerWidth - gridPadding - totalGaps;

        // Floor to prevent subpixel issues causing wrap
        const tileFromWidth = Math.floor(availableWidth / this.gridSize);

        // Height constraint
        const maxGridHeight = screenHeight * (isMobile ? 0.6 : 0.65);
        const availableHeight = maxGridHeight - gridPadding - totalGaps;
        const tileFromHeight = Math.floor(availableHeight / this.gridSize);

        // Choose smaller dimension
        let tileSize = Math.min(tileFromWidth, tileFromHeight);

        // Cap max size
        const MAX_TILE = isMobile ? 55 : 70;
        tileSize = Math.min(tileSize, MAX_TILE);

        const finalTileSize = Math.max(tileSize, 20); // Min 20px

        // Apply
        document.documentElement.style.setProperty('--tile-size', `${finalTileSize}px`);
        document.documentElement.style.setProperty('--grid-size', this.gridSize);

        const gridEl = document.getElementById('pc-grid');
        if (gridEl) {
            gridEl.style.gridTemplateColumns = `repeat(${this.gridSize}, ${finalTileSize}px)`;
            gridEl.style.gap = `${gapSize}px`;
            gridEl.style.padding = `${gridPadding}px`;

            // Ensure grid itself stays centered if tile calculation leaves a pixel remainder
            gridEl.style.width = 'fit-content';
            gridEl.style.margin = '0 auto';
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
        // Ensure no immediate matches (simple check, or just allow it and let user play)
        // For simplicity, we just generate.
    },

    handleInteraction: function (r, c) {
        if (this.isProcessing) return;

        // --- Rainbow Ball Activation ---
        if (this.selectedTile) {
            const sel = this.selectedTile;
            const selTile = this.grid[sel.r][sel.c];
            const clickedTile = this.grid[r][c];

            // If rainbow is selected and clicking a color tile
            if (selTile === 'pc-rainbow' && this.colors.includes(clickedTile)) {
                this.isProcessing = true;
                this.selectedTile = null;
                this.turnClearedCount = 0;
                this.comboCount = 0;
                this.useRainbow(sel.r, sel.c, clickedTile);
                return;
            }
            // If clicking rainbow with a color selected
            if (clickedTile === 'pc-rainbow' && this.colors.includes(selTile)) {
                this.isProcessing = true;
                this.selectedTile = null;
                this.turnClearedCount = 0;
                this.comboCount = 0;
                this.useRainbow(r, c, selTile);
                return;
            }
        }

        // --- Tool Logic (Clean One) ---
        if (this.activeToolMode === 'cleanOne') {
            this.cleanOneRemaining--;
            this.activeToolMode = null;
            this.updateToolButtons();

            // Effect
            const tile = document.querySelector(`.pc-tile[data-r="${r}"][data-c="${c}"]`);
            if (tile) tile.classList.add('pc-pop');

            this.grid[r][c] = null;
            this.updateScore(50);

            setTimeout(async () => {
                await this.applyGravity();
                this.finalizeTurn();
            }, 300);
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
            // --- Forced Swap Mode ---
            if (this.activeToolMode === 'forcedSwap') {
                this.forcedSwapRemaining--;
                this.activeToolMode = null;
                this.updateToolButtons();
                this.swapTiles(r1, c1, r2, c2, true); // Force swap
            } else {
                this.swapTiles(r1, c1, r2, c2, false);
            }
        } else {
            // New selection
            this.selectedTile = { r, c };
            this.renderGrid();
        }
    },

    renderGrid: function () {
        const gridEl = document.getElementById('pc-grid');
        if (!gridEl) return;

        gridEl.innerHTML = '';
        gridEl.style.gridTemplateColumns = `repeat(${this.gridSize}, 1fr)`;

        // Adjust tile size logic if needed
        const containerWidth = Math.min(window.innerWidth - 32, 600); // Max width 600px
        const tileSize = Math.floor((containerWidth - (this.gridSize - 1)) / this.gridSize);
        document.documentElement.style.setProperty('--tile-size', `${tileSize}px`);

        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize; c++) {
                const cell = document.createElement('div');
                cell.classList.add('pc-tile');
                cell.dataset.r = r;
                cell.dataset.c = c;

                // Add content based on grid type
                const type = this.grid[r][c];
                if (type) {
                    if (this.colors.includes(type)) {
                        // It's a color
                        const imgIndex = this.colors.indexOf(type) + 1;
                        cell.style.backgroundImage = `url('assets/${imgIndex}.jpg')`;
                        cell.classList.add('candy-shape');
                    } else {
                        // It's a special tile
                        cell.classList.add(type);
                        if (type === 'pc-rainbow') cell.textContent = '🌈';
                        else if (type === 'pc-bomb') cell.textContent = '💣';
                        else if (type === 'pc-row-bomb') cell.textContent = '↔️';
                        else if (type === 'pc-col-bomb') cell.textContent = '↕️';
                    }
                }

                if (this.selectedTile && this.selectedTile.r === r && this.selectedTile.c === c) {
                    cell.classList.add('selected');
                }

                cell.onclick = () => this.handleInteraction(r, c);
                gridEl.appendChild(cell);
            }
        }
    },

    swapTiles: async function (r1, c1, r2, c2, forceSwap = false) {
        this.isProcessing = true;
        this.selectedTile = null;
        this.comboCount = 0; // Reset combo at start of turn

        // Reset special spawn counters for this move
        this.bombsSpawnedThisTurn = 0;
        this.rainbowsSpawnedThisTurn = 0;
        this.isPlayerInitiatedTurn = true; // Player initiated this turn

        // Swap data
        const temp = this.grid[r1][c1];
        this.grid[r1][c1] = this.grid[r2][c2];
        this.grid[r2][c2] = temp;

        this.renderGrid();

        // Check Special Tile Triggers
        const tile1 = this.grid[r1][c1];
        const tile2 = this.grid[r2][c2];

        // Cross Bomb (existing) - NO special spawn from bomb cascades
        if (tile1 === 'pc-bomb' || tile2 === 'pc-bomb') {
            await new Promise(r => setTimeout(r, 200));
            this.turnClearedCount = 0;
            const bombsToDetonate = [];
            if (tile1 === 'pc-bomb') bombsToDetonate.push({ r: r1, c: c1 });
            if (tile2 === 'pc-bomb') bombsToDetonate.push({ r: r2, c: c2 });
            await this.detonateBombs(bombsToDetonate, false); // allowSpecialSpawn = false
            return;
        }

        // Row Bomb - NO special spawn
        if (tile1 === 'pc-row-bomb' || tile2 === 'pc-row-bomb') {
            await new Promise(r => setTimeout(r, 200));
            this.turnClearedCount = 0;
            if (tile1 === 'pc-row-bomb') await this.detonateRowBomb(r1, c1, false);
            if (tile2 === 'pc-row-bomb') await this.detonateRowBomb(r2, c2, false);
            return;
        }

        // Column Bomb - NO special spawn
        if (tile1 === 'pc-col-bomb' || tile2 === 'pc-col-bomb') {
            await new Promise(r => setTimeout(r, 200));
            this.turnClearedCount = 0;
            if (tile1 === 'pc-col-bomb') await this.detonateColBomb(r1, c1, false);
            if (tile2 === 'pc-col-bomb') await this.detonateColBomb(r2, c2, false);
            return;
        }

        // Normal Match Check - FIRST match allows special spawn
        const matches = this.findMatches();

        if (matches.length > 0 || forceSwap) {
            this.turnClearedCount = 0;
            if (matches.length > 0) {
                // Only the first processMatches allows special spawning
                await this.processMatches(matches, true); // allowSpecialSpawn = true
            } else {
                // Forced swap with no matches
                await this.applyGravity();
                this.finalizeTurn();
            }
        } else {
            // Revert animation
            const t1 = document.querySelector(`.pc-tile[data-r="${r1}"][data-c="${c1}"]`);
            const t2 = document.querySelector(`.pc-tile[data-r="${r2}"][data-c="${c2}"]`);
            if (t1) t1.classList.add('pc-shake');
            if (t2) t2.classList.add('pc-shake');

            await new Promise(r => setTimeout(r, 300));

            // Revert data
            const temp2 = this.grid[r1][c1];
            this.grid[r1][c1] = this.grid[r2][c2];
            this.grid[r2][c2] = temp2;

            this.isProcessing = false;
            this.renderGrid();
        }
    },

    detonateBombs: async function (bombs, allowSpecialSpawn = false) {
        // Bomb explosions are NOT player-initiated for spawn purposes
        this.isPlayerInitiatedTurn = false;

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
            if (tile) tile.classList.add('pc-pop');
        });

        await new Promise(r => setTimeout(r, 300));

        // Score (no combo multiplier for bomb explosions)
        this.updateScore(toClear.size * 20);
        this.turnClearedCount += toClear.size;

        // Clear Data
        toClear.forEach(str => {
            const [r, c] = str.split(',').map(Number);
            this.grid[r][c] = null;
        });

        // Gravity
        await this.applyGravity();

        // Resume match checking - NO special spawns from bomb cascades
        const newMatches = this.findMatches();
        if (newMatches.length > 0) {
            await this.processMatches(newMatches, false); // Never spawn from bomb cascade
        } else {
            this.finalizeTurn();
        }
    },

    processMatches: async function (matches, allowSpecialSpawn = false) {
        // Only increment combo for player-initiated matches
        if (allowSpecialSpawn) {
            this.comboCount++;
        }

        // Check for special tile spawn ONLY if allowed and within caps
        let specialType = null;
        let spawnPos = null;

        if (allowSpecialSpawn) {
            specialType = this.checkSpecialTileSpawn(matches);

            // Apply safety caps
            if (specialType === 'pc-rainbow') {
                if (this.rainbowsSpawnedThisTurn >= this.MAX_RAINBOWS_PER_TURN) {
                    specialType = null; // Already spawned max rainbows
                }
            } else if (specialType === 'pc-row-bomb' || specialType === 'pc-col-bomb') {
                if (this.bombsSpawnedThisTurn >= this.MAX_BOMBS_PER_TURN) {
                    specialType = null; // Already spawned max bombs
                }
            }

            if (specialType) {
                spawnPos = matches[Math.floor(Math.random() * matches.length)];
                // Track spawns
                if (specialType === 'pc-rainbow') {
                    this.rainbowsSpawnedThisTurn++;
                } else if (specialType === 'pc-row-bomb' || specialType === 'pc-col-bomb') {
                    this.bombsSpawnedThisTurn++;
                }
            }
        }

        // Highlight Matches
        matches.forEach(m => {
            const tile = document.querySelector(`.pc-tile[data-r="${m.r}"][data-c="${m.c}"]`);
            if (tile) tile.classList.add('pc-pop');
        });

        await new Promise(r => setTimeout(r, 300));

        // Calculate score (combo multiplier only applies to player-initiated)
        const multiplier = allowSpecialSpawn ? this.getComboMultiplier() : 1;
        const points = matches.length * 10 * multiplier;
        this.updateScore(points);
        this.turnClearedCount += matches.length;

        // Show score pop at first match position
        if (matches.length > 0) {
            this.showScorePop(matches[0].r, matches[0].c, points);
        }

        // Show combo text only for player-initiated matches with multiplier > 1
        if (allowSpecialSpawn && multiplier > 1) {
            this.showComboText(multiplier);
        }

        // Remove from grid (set to null), except spawn position
        matches.forEach(m => {
            if (spawnPos && m.r === spawnPos.r && m.c === spawnPos.c) {
                // Keep this cell for special tile
            } else {
                this.grid[m.r][m.c] = null;
            }
        });

        // Spawn special tile if applicable
        if (spawnPos && specialType) {
            this.grid[spawnPos.r][spawnPos.c] = specialType;
            // Force immediate render to show the new special tile before potential gravity
            this.renderGrid();
        }

        // Gravity
        await this.applyGravity();

        // Check new matches - CASCADE matches do NOT allow special spawns
        const newMatches = this.findMatches();
        if (newMatches.length > 0) {
            await this.processMatches(newMatches, false); // Cascade = NO special spawn
        } else {
            // No more matches -> Turn End
            this.finalizeTurn();
        }
    },

    finalizeTurn: function () {
        // Check for Bomb Reward - ONLY from player-initiated turns with safety cap
        if (this.isPlayerInitiatedTurn &&
            this.turnClearedCount >= 6 &&
            this.bombsSpawnedThisTurn < this.MAX_BOMBS_PER_TURN) {
            this.spawnBomb();
            this.bombsSpawnedThisTurn++;
        }
        this.isProcessing = false;
        this.turnClearedCount = 0;
        this.isPlayerInitiatedTurn = false; // Reset flag
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
    },

    // --- Tool Button Updates ---
    updateToolButtons: function () {
        const cleanBtn = document.getElementById('btn-clean-one');
        const swapBtn = document.getElementById('btn-forced-swap');

        if (cleanBtn) {
            cleanBtn.textContent = `🧹 Clean (${this.cleanOneRemaining})`;
            cleanBtn.disabled = this.cleanOneRemaining <= 0;
            cleanBtn.classList.toggle('active-tool', this.activeToolMode === 'cleanOne');
        }
        if (swapBtn) {
            swapBtn.textContent = `🔄 Swap (${this.forcedSwapRemaining})`;
            swapBtn.disabled = this.forcedSwapRemaining <= 0;
            swapBtn.classList.toggle('active-tool', this.activeToolMode === 'forcedSwap');
        }
    },

    // --- Tool Activation ---
    activateCleanOne: function () {
        if (this.cleanOneRemaining <= 0 || this.isProcessing) return;
        this.activeToolMode = this.activeToolMode === 'cleanOne' ? null : 'cleanOne';
        this.selectedTile = null;
        this.updateToolButtons();
        this.renderGrid();
    },

    activateForcedSwap: function () {
        if (this.forcedSwapRemaining <= 0 || this.isProcessing) return;
        this.activeToolMode = this.activeToolMode === 'forcedSwap' ? null : 'forcedSwap';
        this.selectedTile = null;
        this.updateToolButtons();
        this.renderGrid();
    },

    // --- Score Pop Animation ---
    showScorePop: function (r, c, points) {
        const gridEl = document.getElementById('pc-grid');
        if (!gridEl) return;

        const pop = document.createElement('div');
        pop.className = 'score-pop';
        pop.textContent = `+${points}`;

        // Position relative to grid
        const tileSize = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tile-size')) || 30;
        pop.style.left = `${c * tileSize + tileSize / 2}px`;
        pop.style.top = `${r * tileSize}px`;

        gridEl.appendChild(pop);

        setTimeout(() => pop.remove(), 800);
    },

    // --- Combo Text Animation ---
    showComboText: function (multiplier) {
        if (multiplier < 2) return;

        const container = document.getElementById('app-penny-crush');
        if (!container) return;

        const combo = document.createElement('div');
        combo.className = 'combo-text';
        combo.textContent = `COMBO x${multiplier}!`;

        container.appendChild(combo);

        setTimeout(() => combo.remove(), 1200);
    },

    // --- Score with Combo Multiplier ---
    getComboMultiplier: function () {
        if (this.comboCount <= 1) return 1;
        if (this.comboCount === 2) return 2;
        if (this.comboCount === 3) return 3;
        return 4; // Max x4
    },

    // --- Check for Special Tile Spawn ---
    checkSpecialTileSpawn: function (matches) {
        // Analyze match patterns
        // 4 in a row horizontally -> row bomb
        // 4 in a row vertically -> column bomb
        // 5+ match -> rainbow ball

        if (matches.length >= 5) {
            return 'pc-rainbow';
        }

        // Check for 4 in a row patterns
        const rows = {};
        const cols = {};
        matches.forEach(m => {
            rows[m.r] = (rows[m.r] || 0) + 1;
            cols[m.c] = (cols[m.c] || 0) + 1;
        });

        for (let r in rows) {
            if (rows[r] >= 4) return 'pc-row-bomb';
        }
        for (let c in cols) {
            if (cols[c] >= 4) return 'pc-col-bomb';
        }

        return null;
    },

    // --- Spawn Special Tile ---
    spawnSpecialTile: function (type, matches) {
        if (!type || matches.length === 0) return;

        // Spawn at random position from match
        const pos = matches[Math.floor(Math.random() * matches.length)];
        this.grid[pos.r][pos.c] = type;
    },

    // --- Row Bomb Detonation ---
    detonateRowBomb: async function (r, c, allowSpecialSpawn = false) {
        const toClear = new Set();

        // Clear entire row
        for (let col = 0; col < this.gridSize; col++) {
            toClear.add(`${r},${col}`);
        }

        await this.clearTiles(toClear, 25, false); // No special spawn from bombs
    },

    // --- Column Bomb Detonation ---
    detonateColBomb: async function (r, c, allowSpecialSpawn = false) {
        const toClear = new Set();

        // Clear entire column
        for (let row = 0; row < this.gridSize; row++) {
            toClear.add(`${row},${c}`);
        }

        await this.clearTiles(toClear, 25, false); // No special spawn from bombs
    },

    // --- Rainbow Ball Effect ---
    useRainbow: async function (r, c, targetColor) {
        const toClear = new Set();

        // Find all tiles of target color
        for (let row = 0; row < this.gridSize; row++) {
            for (let col = 0; col < this.gridSize; col++) {
                if (this.grid[row][col] === targetColor) {
                    toClear.add(`${row},${col}`);
                }
            }
        }

        // Also clear the rainbow tile itself
        toClear.add(`${r},${c}`);

        await this.clearTiles(toClear, 30, false); // No special spawn from rainbow
    },

    // --- Generic Tile Clear with Animation ---
    clearTiles: async function (tileSet, pointsPerTile, allowSpecialSpawn = false) {
        // Special tile explosions are NOT player-initiated for spawn purposes
        this.isPlayerInitiatedTurn = false;

        // Visualize
        tileSet.forEach(str => {
            const [r, c] = str.split(',').map(Number);
            const tile = document.querySelector(`.pc-tile[data-r="${r}"][data-c="${c}"]`);
            if (tile) tile.classList.add('pc-pop');
        });

        await new Promise(r => setTimeout(r, 300));

        // Score (no combo multiplier for special explosions)
        const points = tileSet.size * pointsPerTile;
        this.updateScore(points);
        this.turnClearedCount += tileSet.size;

        // Show score pop at center of cleared area
        if (tileSet.size > 0) {
            const first = [...tileSet][0].split(',').map(Number);
            this.showScorePop(first[0], first[1], points);
        }

        // Clear Data
        tileSet.forEach(str => {
            const [r, c] = str.split(',').map(Number);
            this.grid[r][c] = null;
        });

        // Gravity
        await this.applyGravity();

        // Resume match checking - NO special spawns from explosions
        const newMatches = this.findMatches();
        if (newMatches.length > 0) {
            await this.processMatches(newMatches, false); // Never spawn from explosion cascade
        } else {
            this.finalizeTurn();
        }
    },

    // --- Check if tile is special ---
    isSpecialTile: function (r, c) {
        const tile = this.grid[r][c];
        return this.specialTiles.includes(tile);
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

/*
 * =========================================================================
 * GAME HUB CAROUSEL LOGIC
 * =========================================================================
 */

// Games Data Configuration
// Games Data Configuration
const games = [
    {
        id: 'gomoku',
        title: 'Gomoku',
        subtitle: 'Classic strategy game. AI & Online PvP.',
        icon: '⚫⚪',
        action: function () { showApp('gomoku'); },
        playable: true
    },
    {
        id: 'pennycrush',
        title: 'Penny Crush',
        subtitle: 'Match 3 candies! 8x8, 10x10 & 12x12 modes.',
        icon: '🍬',
        action: function () { showApp('pennyCrush'); },
        playable: true
    },
    {
        id: 'coming1',
        title: 'Coming Soon',
        subtitle: 'Under development',
        icon: '🔒',
        action: null,
        playable: false
    }
];

let currentSlide = 0;

function renderCarousel() {
    const track = document.getElementById('game-carousel');
    if (!track) return;

    // Safety check BEFORE clearing
    if (!games || games.length === 0) {
        console.error("Games list is empty or undefined!");
        return;
    }

    track.innerHTML = '';

    games.forEach((game) => {
        const li = document.createElement('li');
        li.className = `game-hub-card ${game.playable ? '' : 'disabled'}`;

        // Use a data attribute to store ID instead of eval
        li.dataset.gameId = game.id;

        // Click handler
        li.onclick = function (e) {
            // Don't trigger if clicking the button (let button handle it or bubble up?)
            // Actually button inside card is cleaner to handle clicks
            if (game.playable && game.action) {
                game.action();
            }
        };

        li.innerHTML = `
            <div class="card-icon">${game.icon}</div>
            <h2>${game.title}</h2>
            <p>${game.subtitle}</p>
            <button class="pill-btn ${game.playable ? 'primary' : 'disabled'}" ${game.playable ? '' : 'disabled'}>
                ${game.playable ? 'Play' : 'Locked'}
            </button>
        `;

        track.appendChild(li);
    });

    updateCarousel();
}



function updateCarousel() {
    // This is called by Prev/Next buttons
    const cards = document.querySelectorAll('.game-hub-card');

    // Use scrollIntoView which is robust with scroll-snap and padding
    if (cards[currentSlide]) {
        cards[currentSlide].scrollIntoView({
            behavior: 'smooth',
            inline: 'center',
            block: 'nearest'
        });
    }

    // Update button states
    updateButtonStates();

    // Force active state update immediately active class
    highlightCard(currentSlide);
}

function updateActiveStateOnScroll() {
    const container = document.querySelector('.carousel-track-container');
    if (!container) return;

    // Find value closest to center of container
    const containerRect = container.getBoundingClientRect();
    const containerCenter = containerRect.left + containerRect.width / 2;

    const cards = document.querySelectorAll('.game-hub-card');
    let closestIndex = -1;
    let minDistance = Infinity;

    cards.forEach((card, index) => {
        const cardRect = card.getBoundingClientRect();
        const cardCenter = cardRect.left + cardRect.width / 2;
        const dist = Math.abs(containerCenter - cardCenter);

        if (dist < minDistance) {
            minDistance = dist;
            closestIndex = index;
        }
    });

    // Threshold can be fairly generous, e.g. half a card width
    if (closestIndex >= 0 && minDistance < 150) {
        if (closestIndex !== currentSlide) {
            currentSlide = closestIndex; // Sync currentSlide state
            updateButtonStates();
        }
        highlightCard(closestIndex);
    }
}

function highlightCard(index) {
    const cards = document.querySelectorAll('.game-hub-card');
    cards.forEach((card, i) => {
        if (i === index) {
            card.classList.add('active-card');
            card.style.opacity = '1';
            card.style.transform = 'scale(1.05)';
        } else {
            card.classList.remove('active-card');
            card.style.opacity = '0.5';
            card.style.transform = 'scale(0.9)';
        }
    });
}

function updateButtonStates() {
    const prevBtn = document.querySelector('.prev-btn');
    const nextBtn = document.querySelector('.next-btn');
    const maxSlide = games.length - 1;

    if (prevBtn) {
        prevBtn.style.opacity = currentSlide === 0 ? '0.3' : '1';
        prevBtn.style.pointerEvents = currentSlide === 0 ? 'none' : 'auto';
    }

    if (nextBtn) {
        const atEnd = currentSlide >= maxSlide;
        nextBtn.style.opacity = atEnd ? '0.3' : '1';
        nextBtn.style.pointerEvents = atEnd ? 'none' : 'auto';
    }
}

function nextGame() {
    if (currentSlide < games.length - 1) {
        currentSlide++;
        updateCarousel();
    }
}

function prevGame() {
    if (currentSlide > 0) {
        currentSlide--;
        updateCarousel();
    }
}

// Initialize Carousel on Load
window.addEventListener('load', () => {
    // Force initial scroll position adjustment for style
    renderCarousel();
    const container = document.querySelector('.carousel-track-container');
    if (container) {
        // Debounced active state update
        let scrollTimeout;
        container.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                updateActiveStateOnScroll();
            }, 50); // Debounce 50ms
        }, { passive: true });
    }

    // Also trigger update once to set initial active class
    setTimeout(updateActiveStateOnScroll, 100);
});

// Also try immediately incase load already happened
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    renderCarousel();
    setTimeout(updateActiveStateOnScroll, 100);
}

// --- Online Room Logic ---

async function joinRoom(code) {
    if (!code) {
        alert("請輸入房間代碼！");
        return;
    }
    roomId = code;

    // 0. Check Supabase
    if (!supabase) {
        alert("Online services unavailable (SDK not loaded).");
        return;
    }

    // 1. Fetch Room State
    let { data: room, error } = await supabase
        .from("Gomoku's rooms")
        .select('*')
        .eq('room_code', roomId)
        .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "Row not found"
        console.error("Fetch room error:", error);
        alert("無法連接房間");
        return;
    }

    // 2. Create if not exists
    if (!room) {
        const { data: newRoom, error: createError } = await supabase
            .from("Gomoku's rooms")
            .insert([{
                room_code: roomId,
                black_player_id: clientId, // Creator is Black
                status: 'waiting',
                last_activity_at: new Date()
            }])
            .select()
            .single();

        if (createError) {
            console.error("Create room error:", createError);
            alert("創建房間失敗");
            return;
        }
        room = newRoom;
        playerRole = 'black';
    } else {
        // 3. Assign Role logic
        if (room.black_player_id === clientId) {
            playerRole = 'black';
        } else if (room.white_player_id === clientId) {
            playerRole = 'white';
        } else if (!room.black_player_id) {
            await safeUpdateRoomDB(room.id, { black_player_id: clientId, status: 'playing' });
            playerRole = 'black';
        } else if (!room.white_player_id) {
            await safeUpdateRoomDB(room.id, { white_player_id: clientId, status: 'playing' });
            playerRole = 'white';
        } else {
            playerRole = 'spectator';
        }
    }

    // Set Record ID for future updates
    roomRecordId = room.id;

    // Update local role UI
    document.getElementById('current-room-id').innerText = roomId;
    updateRoleUI();

    // Reset local board
    resetBoard();

    // Subscribe to Realtime Changes
    subscribeToRoom();

    showView('online-room');
    updateStatus(`加入房間成功！身份: ${getRoleName(playerRole)}`);
}

async function safeUpdateRoomDB(id, updates) {
    const { error } = await supabase.from("Gomoku's rooms").update({
        ...updates,
        last_activity_at: new Date()
    }).eq('id', id);
    if (error) console.error("Update error:", error);
}

function getRoleName(role) {
    if (role === 'black') return '黑子玩家';
    if (role === 'white') return '白子玩家';
    return '觀戰者';
}

function subscribeToRoom() {
    if (roomChannel) {
        supabase.removeChannel(roomChannel);
    }

    roomChannel = supabase.channel(`room-${roomId}`)
        .on(
            "postgres_changes",
            {
                event: "*",
                schema: "public",
                table: "Gomoku's rooms",
                filter: `room_code=eq.${roomId}`,
            },
            (payload) => {
                console.log('Room update:', payload);
                if (payload.new) {
                    handleRoomUpdate(payload.new);
                }
            }
        )
        .subscribe((status) => {
            console.log("Subscription status:", status);
        });
}

function handleRoomUpdate(room) {
    // Check if I was kicked or role changed
    const myId = clientId;
    if (playerRole === 'black' && room.black_player_id !== myId) {
        playerRole = 'spectator';
        alert("你已被移除黑子位置");
    } else if (playerRole === 'white' && room.white_player_id !== myId) {
        playerRole = 'spectator';
        alert("你已被移除白子位置");
    }

    updateRoleUI();

    // Sync Board State if it exists
    if (room.board_state) {
        try {
            const remoteBoard = JSON.parse(room.board_state);
            // Simple diff to see if we need to update
            if (JSON.stringify(remoteBoard) !== JSON.stringify(board)) {
                board = remoteBoard;
                // Re-render stones
                const stones = document.querySelectorAll('.stone');
                stones.forEach(s => s.remove());
                for (let r = 0; r < BOARD_SIZE; r++) {
                    for (let c = 0; c < BOARD_SIZE; c++) {
                        if (board[r][c]) {
                            const cell = document.querySelector(`.cell[data-row='${r}'][data-col='${c}']`);
                            if (cell && !cell.querySelector('.stone')) {
                                const stone = document.createElement('div');
                                stone.classList.add('stone', board[r][c]);
                                cell.appendChild(stone);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Error parsing board state", e);
        }
    }

    // Sync current player
    // We can infer current player from board stone count if we want strictly turn based,
    // or store it. Let's infer to save a column: Black always moves on even number of stones?
    // Black moves 1 (1 stone), White moves 2 (2 stones).
    // Count stones:
    let stonesCount = 0;
    if (room.board_state) { // only if we have board
        // ... helper to count ...
        // Or just read 'last_result'
    }

    // Check Game Over
    if (room.last_result) {
        gameOver = true;
        if (room.last_result === 'black_win') statusElement.innerHTML = "黑子獲勝！";
        else if (room.last_result === 'white_win') statusElement.innerHTML = "白子獲勝！";
        else if (room.last_result === 'draw') statusElement.innerHTML = "和局！";
    } else {
        if (room.status === 'playing') {
            // Verify whose turn it is
            // This logic depends on board state.
            // For now, let's just trust local unless we add current_player column.
            // Using board count:
            let bCount = 0;
            let wCount = 0;
            for (let r = 0; r < BOARD_SIZE; r++) {
                for (let c = 0; c < BOARD_SIZE; c++) {
                    if (board[r][c] === 'black') bCount++;
                    if (board[r][c] === 'white') wCount++;
                }
            }
            if (bCount === wCount) currentPlayer = 'black';
            else currentPlayer = 'white';

            updateStatus();
        }
    }
}

function updateRoleUI() {
    const roleSpan = document.getElementById('my-role');
    const startBtn = document.getElementById('online-start-btn');
    // const leaveBtn = document.getElementById('leave-room-btn');

    let roleText = '觀眾';
    if (playerRole === 'black') roleText = '黑子';
    if (playerRole === 'white') roleText = '白子';

    roleSpan.innerText = roleText;

    const resetBtn = document.getElementById('reset-btn');
    if (playerRole === 'black' || playerRole === 'white') {
        startBtn.classList.remove('hidden');
        resetBtn.style.display = 'inline-block';
    } else {
        startBtn.classList.add('hidden');
        resetBtn.style.display = 'none';
    }
}

async function startOnlineGame() {
    // Only players can start/restart
    if (playerRole !== 'black' && playerRole !== 'white') return;

    // Reset board locally
    resetGame();

    // Update DB
    await safeUpdateRoomDB(roomRecordId, {
        status: 'playing',
        last_result: null,
        board_state: JSON.stringify(createEmptyBoard()) // We need to write empty board
    });
}

function createEmptyBoard() {
    const b = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
        const row = [];
        for (let c = 0; c < BOARD_SIZE; c++) row.push(null);
        b.push(row);
    }
    return b;
}

// Reset local board purely (visuals handled in resetGame)
function resetBoard() {
    resetGame();
}

async function leaveRoom() {
    if (roomRecordId && playerRole && playerRole !== 'spectator') {
        const updates = {};
        if (playerRole === 'black') updates.black_player_id = null;
        if (playerRole === 'white') updates.white_player_id = null;

        if (Object.keys(updates).length > 0) {
            await safeUpdateRoomDB(roomRecordId, updates);
        }
    }

    if (roomChannel) {
        supabase.removeChannel(roomChannel);
        roomChannel = null;
    }

    // Reset state
    roomId = null;
    roomRecordId = null;
    playerRole = null;
    showView('landing');
}

// Broadcast Move - Now writes to DB
async function broadcastMove(row, col, player) {
    if (mode === 'online' && roomChannel) {
        // Optimistic update already happened in PlaceStone

        // Write to DB
        // We need to write the FULL board state
        await safeUpdateRoomDB(roomRecordId, {
            board_state: JSON.stringify(board),
            // current_player: ... no column?
        });
    }
}

async function becomePlayer(role) {
    if (!roomRecordId) return;

    // Check if taken
    let { data: room } = await supabase
        .from("Gomoku's rooms")
        .select('*')
        .eq('id', roomRecordId)
        .single();

    if (role === 'black') {
        if (room.black_player_id && room.black_player_id !== clientId) {
            alert("黑子位置已被占用");
            return;
        }
        await safeUpdateRoomDB(roomRecordId, { black_player_id: clientId });
        playerRole = 'black';
    } else if (role === 'white') {
        if (room.white_player_id && room.white_player_id !== clientId) {
            alert("白子位置已被占用");
            return;
        }
        await safeUpdateRoomDB(roomRecordId, { white_player_id: clientId });
        playerRole = 'white';
    }
    updateRoleUI();
}

async function becomeSpectator() {
    if (playerRole === 'spectator') return;
    if (playerRole === 'black' || playerRole === 'white') {
        const updates = {};
        if (playerRole === 'black') updates.black_player_id = null;
        if (playerRole === 'white') updates.white_player_id = null;
        await safeUpdateRoomDB(roomRecordId, updates);
    }
    playerRole = 'spectator';
    updateRoleUI();
}

// Ensure Globals for HTML
window.showView = showView;
window.selectMode = selectMode;
window.joinRoom = joinRoom;
window.leaveRoom = leaveRoom;
window.resetGame = resetGame;
window.handleCellClick = handleCellClick;
window.PennyCrush = PennyCrush;
window.showApp = showApp;
window.nextGame = nextGame;
window.prevGame = prevGame;
window.backToLanding = backToLanding;
window.becomePlayer = becomePlayer;
window.becomeSpectator = becomeSpectator;
window.startOnlineGame = startOnlineGame;
window.toggleModeSelection = toggleModeSelection;



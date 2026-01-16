const BOARD_SIZE = 15;
const boardElement = document.getElementById('board');
const statusElement = document.getElementById('status');

// We need to query this inside updateStatus/resetGame now because it might be overwritten by innerHTML updates
let playerTurnSpan = document.querySelector('.player-turn');

let board = [];
let currentPlayer = 'black';
let gameOver = false;
let isVsAI = true; // AI mode enabled by default

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
    if (gameOver || board[row][col] !== null) {
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

    let move = findBestMove();
    if (move) {
        placeStone(move.r, move.c);
        if (checkWin(move.r, move.c, currentPlayer)) {
            statusElement.innerHTML = `<span class="player-turn" style="color: ${currentPlayer === 'black' ? '#000' : '#888'}">${getPlayerName(currentPlayer)} 獲勝！</span>`;
            return;
        }
        switchTurn();
    }
}

// Heuristic Scoring System
function findBestMove() {
    let bestScore = -Infinity;
    let bestMoves = [];

    // Evaluate every empty cell
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            if (board[r][c] === null) {
                // Score for AI (Attack)
                const attackScore = evaluatePoint(r, c, 'white');
                // Score for Player (Defense)
                const defenseScore = evaluatePoint(r, c, 'black');

                // Final score logic:
                // We value winning slightly more than blocking, but if opponent has a killer move, we must block.
                // However, evaluatePoint returns very high numbers for threats.
                // We sum them because a move might both attack AND defend.
                // We can weight defense slightly higher to be safe, or just sum them.
                let totalScore = attackScore + defenseScore;

                // Tie-breaking with position heuristic (slightly prefer center)
                const centerDist = Math.abs(r - 7) + Math.abs(c - 7);
                totalScore -= centerDist; // minuscule penalty for being far from center

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

    // Fallback (shouldn't happen on empty board properly handled above)
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

function countDirection(row, col, dx, dy, player) {
    let count = 0;
    let r = row + dx;
    let c = col + dy;

    while (
        r >= 0 && r < 15 &&
        c >= 0 && c < 15 &&
        board[r][c] === player
    ) {
        count++;
        r += dx;
        c += dy;
    }
    return count;
}

// Added isSimulating flag to prevent alerts during AI calculation
function checkWin(row, col, player, isSimulating = false) {
    const directions = [
        [0, 1],   // horizontal
        [1, 0],   // vertical
        [1, 1],   // diagonal right-down
        [1, -1],  // diagonal left-down
    ];

    for (const [dx, dy] of directions) {
        const total =
            1 +
            countDirection(row, col, dx, dy, player) +
            countDirection(row, col, -dx, -dy, player);

        if (total >= 5) {
            if (!isSimulating) {
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

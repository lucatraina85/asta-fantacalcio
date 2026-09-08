const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Struttura dati per gestire più stanze in contemporanea
// rooms = { "CodiceStanza": { auctionState, userCredits, lastTransaction, timerInterval } }
let rooms = {};

function getOrCreateRoom(roomCode) {
    const code = roomCode.trim().toUpperCase();
    if (!rooms[code]) {
        rooms[code] = {
            auctionState: {
                currentPlayer: "",
                highestBidder: "",
                currentBid: 0,
                timer: 5,
                isTimerRunning: false
            },
            userCredits: new Map(),
            lastTransaction: null,
            timerInterval: null
        };
    }
    return rooms[code];
}

function startTimer(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    clearInterval(room.timerInterval);
    room.auctionState.timer = 5;
    room.auctionState.isTimerRunning = true;
    io.to(roomCode).emit('stateUpdate', getStateData(roomCode));

    room.timerInterval = setInterval(() => {
        room.auctionState.timer--;

        if (room.auctionState.timer <= 0) {
            clearInterval(room.timerInterval);
            room.auctionState.isTimerRunning = false;

            const winner = room.auctionState.highestBidder;
            const price = room.auctionState.currentBid;
            const player = room.auctionState.currentPlayer;

            if (winner && room.userCredits.has(winner)) {
                const currentBalance = room.userCredits.get(winner);
                const newBalance = Math.max(0, currentBalance - price);
                room.userCredits.set(winner, newBalance);

                room.lastTransaction = {
                    winner: winner,
                    price: price,
                    player: player
                };
            } else {
                room.lastTransaction = null;
            }

            io.to(roomCode).emit('auctionEnded', {
                player: player,
                winner: winner || "Nessuno",
                price: price,
                userCredits: Object.fromEntries(room.userCredits),
                lastTransaction: room.lastTransaction
            });

            room.auctionState.currentPlayer = "";
            room.auctionState.highestBidder = "";
            room.auctionState.currentBid = 0;
            room.auctionState.timer = 5;
        }

        io.to(roomCode).emit('stateUpdate', getStateData(roomCode));
    }, 1000);
}

function getStateData(roomCode) {
    const room = rooms[roomCode];
    if (!room) return {};
    return {
        ...room.auctionState,
        userCredits: Object.fromEntries(room.userCredits),
        lastTransaction: room.lastTransaction
    };
}

io.on('connection', (socket) => {
    let currentRoom = null;
    let currentUser = null;

    socket.on('joinRoom', (data) => {
        const roomCode = data.roomCode ? data.roomCode.trim().toUpperCase() : "GENERALE";
        const userName = data.name ? data.name.trim() : "Anonimo";

        currentRoom = roomCode;
        currentUser = userName;

        socket.join(roomCode);
        const room = getOrCreateRoom(roomCode);

        if (!room.userCredits.has(userName)) {
            room.userCredits.set(userName, 500);
        }

        io.to(roomCode).emit('stateUpdate', getStateData(roomCode));
    });

    socket.on('callPlayer', (data) => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        const playerName = data.playerName ? data.playerName.trim() : "";
        const callerName = data.userName || currentUser;

        if (playerName !== "" && room) {
            const userBalance = room.userCredits.get(callerName) || 0;
            if (userBalance >= 1) {
                room.auctionState.currentPlayer = playerName;
                room.auctionState.highestBidder = callerName;
                room.auctionState.currentBid = 1;
                startTimer(currentRoom);
            } else {
                socket.emit('errorMsg', 'Non hai abbastanza crediti per chiamare un giocatore!');
            }
        }
    });

    socket.on('placeIncrementBid', (data) => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];

        if (room && room.auctionState.isTimerRunning && room.auctionState.timer > 0) {
            const increment = parseInt(data.increment) || 1;
            const newBid = room.auctionState.currentBid + increment;
            const userBalance = room.userCredits.get(data.userName) || 0;

            if (userBalance >= newBid) {
                room.auctionState.currentBid = newBid;
                room.auctionState.highestBidder = data.userName;
                startTimer(currentRoom);
            } else {
                socket.emit('errorMsg', 'Crediti insufficienti per questa offerta!');
            }
        }
    });

    socket.on('resetAuction', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room) {
            clearInterval(room.timerInterval);
            room.auctionState.currentPlayer = "";
            room.auctionState.highestBidder = "";
            room.auctionState.currentBid = 0;
            room.auctionState.timer = 5;
            room.auctionState.isTimerRunning = false;
            io.to(currentRoom).emit('stateUpdate', getStateData(currentRoom));
        }
    });

    // --- BANDITORE ---
    socket.on('updateUserCredits', (data) => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room && room.userCredits.has(data.userName)) {
            room.userCredits.set(data.userName, parseInt(data.newCredits) || 0);
            io.to(currentRoom).emit('stateUpdate', getStateData(currentRoom));
        }
    });

    socket.on('resetAllCredits', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room) {
            for (let user of room.userCredits.keys()) {
                room.userCredits.set(user, 500);
            }
            room.lastTransaction = null;
            io.to(currentRoom).emit('stateUpdate', getStateData(currentRoom));
        }
    });

    socket.on('undoLastTransaction', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room && room.lastTransaction && room.userCredits.has(room.lastTransaction.winner)) {
            const currentBalance = room.userCredits.get(room.lastTransaction.winner);
            const restoredBalance = currentBalance + room.lastTransaction.price;
            room.userCredits.set(room.lastTransaction.winner, restoredBalance);

            const undone = room.lastTransaction;
            room.lastTransaction = null;

            io.to(currentRoom).emit('transactionUndone', undone);
            io.to(currentRoom).emit('stateUpdate', getStateData(currentRoom));
        } else {
            socket.emit('errorMsg', 'Nessuna transazione recente da annullare!');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server attivo sulla porta ${PORT}`);
});

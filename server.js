const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'database.json');
let rooms = {};

function loadData() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const rawData = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(rawData);
            
            for (let code in parsed) {
                rooms[code] = {
                    auctionState: parsed[code].auctionState,
                    userCredits: new Map(Object.entries(parsed[code].userCredits || {})),
                    purchases: parsed[code].purchases || [],
                    timerInterval: null
                };
                rooms[code].auctionState.isTimerRunning = false;
            }
        }
    } catch (err) {
        console.error('Errore caricamento database:', err);
    }
}

function saveData() {
    try {
        const toSave = {};
        for (let code in rooms) {
            toSave[code] = {
                auctionState: rooms[code].auctionState,
                userCredits: Object.fromEntries(rooms[code].userCredits),
                purchases: rooms[code].purchases || []
            };
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(toSave, null, 2), 'utf8');
    } catch (err) {
        console.error('Errore salvataggio database:', err);
    }
}

loadData();

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
            purchases: [],
            timerInterval: null
        };
        saveData();
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

                if (!room.purchases) room.purchases = [];
                room.purchases.push({
                    player: player,
                    winner: winner,
                    price: price,
                    id: Date.now()
                });
            }

            saveData();

            io.to(roomCode).emit('auctionEnded', {
                player: player,
                winner: winner || "Nessuno",
                price: price,
                userCredits: Object.fromEntries(room.userCredits),
                purchases: room.purchases
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
        purchases: room.purchases || []
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

        if (userName !== "TABELLONE" && !room.userCredits.has(userName)) {
            room.userCredits.set(userName, 500);
            saveData();
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
            saveData();
            io.to(currentRoom).emit('stateUpdate', getStateData(currentRoom));
        }
    });

    socket.on('updateUserCredits', (data) => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room && room.userCredits.has(data.userName)) {
            room.userCredits.set(data.userName, parseInt(data.newCredits) || 0);
            saveData();
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
            room.purchases = [];
            saveData();
            io.to(currentRoom).emit('stateUpdate', getStateData(currentRoom));
        }
    });

    socket.on('undoLastTransaction', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room && room.purchases && room.purchases.length > 0) {
            const lastPurchase = room.purchases.pop();
            if (room.userCredits.has(lastPurchase.winner)) {
                const currentBalance = room.userCredits.get(lastPurchase.winner);
                room.userCredits.set(lastPurchase.winner, currentBalance + lastPurchase.price);
            }
            saveData();
            io.to(currentRoom).emit('transactionUndone', lastPurchase);
            io.to(currentRoom).emit('stateUpdate', getStateData(currentRoom));
        } else {
            socket.emit('errorMsg', 'Nessun acquisto da annullare!');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server attivo sulla porta ${PORT}`);
});

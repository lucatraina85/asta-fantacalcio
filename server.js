const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let auctionState = {
    currentPlayer: "",
    highestBidder: "",
    currentBid: 0,
    timer: 5,
    isTimerRunning: false
};

// Tracciamento dei crediti per ciascun utente (Nome Utente -> Crediti)
let userCredits = new Map();
let connectedUsers = new Map(); // socket.id -> userName
let timerInterval = null;

function startTimer() {
    clearInterval(timerInterval);
    auctionState.timer = 5;
    auctionState.isTimerRunning = true;
    io.emit('stateUpdate', getStateData());

    timerInterval = setInterval(() => {
        auctionState.timer--;

        if (auctionState.timer <= 0) {
            clearInterval(timerInterval);
            auctionState.isTimerRunning = false;

            const winner = auctionState.highestBidder;
            const price = auctionState.currentBid;
            const player = auctionState.currentPlayer;

            // Scaliamo i crediti solo a chi ha vinto l'asta
            if (winner && userCredits.has(winner)) {
                const currentBalance = userCredits.get(winner);
                const newBalance = Math.max(0, currentBalance - price);
                userCredits.set(winner, newBalance);
            }

            io.emit('auctionEnded', {
                player: player,
                winner: winner || "Nessuno",
                price: price,
                userCredits: Object.fromEntries(userCredits)
            });

            // Resetta per il prossimo calciatore
            auctionState.currentPlayer = "";
            auctionState.highestBidder = "";
            auctionState.currentBid = 0;
            auctionState.timer = 5;
        }

        io.emit('stateUpdate', getStateData());
    }, 1000);
}

function getStateData() {
    return {
        ...auctionState,
        userCredits: Object.fromEntries(userCredits)
    };
}

io.on('connection', (socket) => {
    socket.emit('stateUpdate', getStateData());

    socket.on('registerUser', (userName) => {
        connectedUsers.set(socket.id, userName);
        if (!userCredits.has(userName)) {
            userCredits.set(userName, 500);
        }
        io.emit('stateUpdate', getStateData());
    });

    socket.on('callPlayer', (playerName) => {
        if (playerName.trim() !== "") {
            auctionState.currentPlayer = playerName;
            auctionState.highestBidder = "";
            auctionState.currentBid = 0;
            startTimer();
        }
    });

    socket.on('placeIncrementBid', (data) => {
        if (auctionState.isTimerRunning && auctionState.timer > 0) {
            const increment = parseInt(data.increment) || 1;
            const newBid = auctionState.currentBid + increment;
            const userBalance = userCredits.get(data.userName) || 0;

            if (userBalance >= newBid) {
                auctionState.currentBid = newBid;
                auctionState.highestBidder = data.userName;
                startTimer();
            } else {
                socket.emit('errorMsg', 'Crediti insufficienti per questa offerta!');
            }
        }
    });

    socket.on('resetAuction', () => {
        clearInterval(timerInterval);
        auctionState.currentPlayer = "";
        auctionState.highestBidder = "";
        auctionState.currentBid = 0;
        auctionState.timer = 5;
        auctionState.isTimerRunning = false;
        io.emit('stateUpdate', getStateData());
    });

    socket.on('disconnect', () => {
        connectedUsers.delete(socket.id);
        io.emit('stateUpdate', getStateData());
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server attivo sulla porta ${PORT}`);
});

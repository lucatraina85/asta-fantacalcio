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
    isTimerRunning: false,
    readyUsers: []
};

let connectedUsers = new Map();
let timerInterval = null;

function startTimer() {
    clearInterval(timerInterval);
    auctionState.timer = 5;
    auctionState.isTimerRunning = true;
    io.emit('stateUpdate', getStateWithReadyCount());

    timerInterval = setInterval(() => {
        auctionState.timer--;

        if (auctionState.timer <= 0) {
            clearInterval(timerInterval);
            auctionState.isTimerRunning = false;

            const winner = auctionState.highestBidder || "Nessuno";
            const price = auctionState.currentBid;
            const player = auctionState.currentPlayer;

            io.emit('auctionEnded', {
                player: player,
                winner: winner,
                price: price
            });

            // Resetta per il prossimo calciatore
            auctionState.currentPlayer = "";
            auctionState.highestBidder = "";
            auctionState.currentBid = 0;
            auctionState.timer = 5;
            auctionState.readyUsers = [];
        }

        io.emit('stateUpdate', getStateWithReadyCount());
    }, 1000);
}

function getStateWithReadyCount() {
    return {
        ...auctionState,
        readyCount: auctionState.readyUsers.length,
        totalUsers: 10
    };
}

io.on('connection', (socket) => {
    socket.emit('stateUpdate', getStateWithReadyCount());

    socket.on('registerUser', (userName) => {
        connectedUsers.set(socket.id, userName);
    });

    socket.on('callPlayer', (playerName) => {
        clearInterval(timerInterval);
        auctionState.currentPlayer = playerName;
        auctionState.highestBidder = "";
        auctionState.currentBid = 0;
        auctionState.timer = 5;
        auctionState.isTimerRunning = false;
        auctionState.readyUsers = [];
        io.emit('stateUpdate', getStateWithReadyCount());
    });

    socket.on('setUserReady', () => {
        if (!auctionState.isTimerRunning && auctionState.currentPlayer !== "") {
            if (!auctionState.readyUsers.includes(socket.id)) {
                auctionState.readyUsers.push(socket.id);
                io.emit('stateUpdate', getStateWithReadyCount());

                if (auctionState.readyUsers.length >= 10) {
                    startTimer();
                }
            }
        }
    });

    socket.on('forceStartAuction', () => {
        if (auctionState.currentPlayer !== "") {
            startTimer();
        }
    });

    socket.on('placeIncrementBid', (data) => {
        if (auctionState.isTimerRunning && auctionState.timer > 0) {
            const increment = parseInt(data.increment) || 1;
            auctionState.currentBid += increment;
            auctionState.highestBidder = data.userName;
            startTimer(); // Reset timer a 5s
        }
    });

    socket.on('resetAuction', () => {
        clearInterval(timerInterval);
        auctionState.currentPlayer = "";
        auctionState.highestBidder = "";
        auctionState.currentBid = 0;
        auctionState.timer = 5;
        auctionState.isTimerRunning = false;
        auctionState.readyUsers = [];
        io.emit('stateUpdate', getStateWithReadyCount());
    });

    socket.on('disconnect', () => {
        connectedUsers.delete(socket.id);
        auctionState.readyUsers = auctionState.readyUsers.filter(id => id !== socket.id);
        io.emit('stateUpdate', getStateWithReadyCount());
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server attivo sulla porta ${PORT}`);
});

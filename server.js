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
    timer: 10,
    isTimerRunning: false,
    banditoreId: null
};

let timerInterval = null;

function resetAuction() {
    clearInterval(timerInterval);
    auctionState.currentPlayer = "";
    auctionState.highestBidder = "";
    auctionState.currentBid = 0;
    auctionState.timer = 10;
    auctionState.isTimerRunning = false;
    io.emit('stateUpdate', auctionState);
}

function startTimer() {
    clearInterval(timerInterval);
    auctionState.timer = 10;
    auctionState.isTimerRunning = true;
    io.emit('stateUpdate', auctionState);

    timerInterval = setInterval(() => {
        if (auctionState.timer > 0) {
            auctionState.timer--;
            io.emit('timerTick', auctionState.timer);
        } else {
            clearInterval(timerInterval);
            auctionState.isTimerRunning = false;
            io.emit('stateUpdate', auctionState);
        }
    }, 1000);
}

io.on('connection', (socket) => {
    if (!auctionState.banditoreId) {
        auctionState.banditoreId = socket.id;
    }

    socket.emit('init', {
        state: auctionState,
        isBanditore: socket.id === auctionState.banditoreId
    });

    socket.on('startAuction', (data) => {
        auctionState.currentPlayer = data.playerName;
        auctionState.currentBid = 1;
        auctionState.highestBidder = data.userName;
        startTimer();
    });

    socket.on('placeBid', (data) => {
        if (!auctionState.currentPlayer) return;

        auctionState.currentBid += data.increment;
        auctionState.highestBidder = data.userName;
        startTimer();
    });

    socket.on('closeAuction', () => {
        if (socket.id !== auctionState.banditoreId) return;
        
        io.emit('auctionClosed', {
            player: auctionState.currentPlayer,
            winner: auctionState.highestBidder,
            price: auctionState.currentBid
        });

        resetAuction();
    });

    socket.on('disconnect', () => {
        if (socket.id === auctionState.banditoreId) {
            auctionState.banditoreId = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server attivo su http://localhost:${PORT}`);
});
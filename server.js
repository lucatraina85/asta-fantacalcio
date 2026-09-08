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

let userCredits = new Map();
let connectedUsers = new Map();
let lastAuctionTransaction = null; // Memorizza l'ultimo acquisto per permettere l'annullamento
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

            if (winner && userCredits.has(winner)) {
                const currentBalance = userCredits.get(winner);
                const newBalance = Math.max(0, currentBalance - price);
                userCredits.set(winner, newBalance);

                // Salviamo l'ultima transazione per eventuale annullamento
                lastAuctionTransaction = {
                    winner: winner,
                    price: price,
                    player: player
                };
            } else {
                lastAuctionTransaction = null;
            }

            io.emit('auctionEnded', {
                player: player,
                winner: winner || "Nessuno",
                price: price,
                userCredits: Object.fromEntries(userCredits),
                lastTransaction: lastAuctionTransaction
            });

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
        userCredits: Object.fromEntries(userCredits),
        lastTransaction: lastAuctionTransaction
    };
}

io.on('connection', (socket) => {
    socket.emit('stateUpdate', getStateData());

    socket.on('registerUser', (data) => {
        const userName = typeof data === 'object' ? data.name : data;
        connectedUsers.set(socket.id, userName);
        if (!userCredits.has(userName)) {
            userCredits.set(userName, 500);
        }
        io.emit('stateUpdate', getStateData());
    });

    // Chi chiama il giocatore fa automaticamente la prima offerta a 1 credito
    socket.on('callPlayer', (data) => {
        const playerName = typeof data === 'object' ? data.playerName : data;
        const callerName = typeof data === 'object' ? data.userName : connectedUsers.get(socket.id);

        if (playerName && playerName.trim() !== "") {
            const userBalance = userCredits.get(callerName) || 0;
            
            if (userBalance >= 1) {
                auctionState.currentPlayer = playerName.trim();
                auctionState.highestBidder = callerName;
                auctionState.currentBid = 1; // Offerta automatica a +1
                startTimer();
            } else {
                socket.emit('errorMsg', 'Non hai abbastanza crediti per chiamare un giocatore!');
            }
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

    // --- FUNZIONALITÀ BANDITORE ---

    // Modifica manuale dei crediti di un utente
    socket.on('updateUserCredits', (data) => {
        if (userCredits.has(data.userName)) {
            userCredits.set(data.userName, parseInt(data.newCredits) || 0);
            io.emit('stateUpdate', getStateData());
        }
    });

    // Reset crediti di TUTTI a 500
    socket.on('resetAllCredits', () => {
        for (let user of userCredits.keys()) {
            userCredits.set(user, 500);
        }
        lastAuctionTransaction = null;
        io.emit('stateUpdate', getStateData());
    });

    // Annulla l'ultimo acquisto effettuato
    socket.on('undoLastTransaction', () => {
        if (lastAuctionTransaction && userCredits.has(lastAuctionTransaction.winner)) {
            const currentBalance = userCredits.get(lastAuctionTransaction.winner);
            const restoredBalance = currentBalance + lastAuctionTransaction.price;
            userCredits.set(lastAuctionTransaction.winner, restoredBalance);
            
            const undone = lastAuctionTransaction;
            lastAuctionTransaction = null;
            
            io.emit('transactionUndone', undone);
            io.emit('stateUpdate', getStateData());
        } else {
            socket.emit('errorMsg', 'Nessuna transazione recente da annullare!');
        }
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

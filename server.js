const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    pingInterval: 2000,
    pingTimeout: 5000
});

app.use(express.static(__dirname + '/public'));

// ========== ROOMS ==========
const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return rooms.has(code) ? generateRoomCode() : code;
}

function cleanupRoom(code) {
    const room = rooms.get(code);
    if (!room) return;
    if (room.players.length === 0) {
        rooms.delete(code);
        console.log(`Room ${code} deleted (empty)`);
    }
}

// ========== SOCKET ==========
io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);
    let currentRoom = null;

    // Create room
    socket.on('createRoom', (data) => {
        const code = generateRoomCode();
        const room = {
            code,
            host: socket.id,
            players: [{
                id: socket.id,
                name: data.name || 'Oyuncu',
                weaponIdx: data.weaponIdx || 0,
                state: null,
                ready: false
            }],
            state: 'lobby', // lobby, playing, roundEnd
            maxPlayers: 8,
            roundNum: 0,
            botCount: data.botCount || 3
        };
        rooms.set(code, room);
        socket.join(code);
        currentRoom = code;
        socket.emit('roomCreated', { code, players: room.players.map(p => ({ id: p.id, name: p.name, weaponIdx: p.weaponIdx })) });
        console.log(`Room ${code} created by ${data.name}`);
    });

    // Join room
    socket.on('joinRoom', (data) => {
        const code = (data.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { socket.emit('joinError', 'Oda bulunamadı!'); return; }
        if (room.players.length >= room.maxPlayers) { socket.emit('joinError', 'Oda dolu!'); return; }
        if (room.state !== 'lobby') { socket.emit('joinError', 'Maç devam ediyor!'); return; }

        room.players.push({
            id: socket.id,
            name: data.name || 'Oyuncu',
            weaponIdx: data.weaponIdx || 0,
            state: null,
            ready: false
        });
        socket.join(code);
        currentRoom = code;

        const playerList = room.players.map(p => ({ id: p.id, name: p.name, weaponIdx: p.weaponIdx }));
        socket.emit('roomJoined', { code, players: playerList, hostId: room.host });
        socket.to(code).emit('playerJoined', { id: socket.id, name: data.name, weaponIdx: data.weaponIdx, players: playerList });
        console.log(`${data.name} joined room ${code} (${room.players.length} players)`);
    });

    // Update weapon
    socket.on('updateWeapon', (data) => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const p = room.players.find(p => p.id === socket.id);
        if (p) p.weaponIdx = data.weaponIdx;
        io.to(currentRoom).emit('weaponUpdated', { id: socket.id, weaponIdx: data.weaponIdx });
    });

    // Start game (host only)
    socket.on('startGame', (data) => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || room.host !== socket.id) return;
        if (room.players.length < 1) { socket.emit('joinError', 'En az 1 oyuncu gerekli!'); return; }

        room.state = 'playing';
        room.roundNum++;
        if (data && data.botCount !== undefined) room.botCount = data.botCount;
        if (data && data.botDiff !== undefined) room.botDiff = data.botDiff;

        // Assign spawn positions
        const spawns = [];
        const spacing = 900 / (room.players.length + 1);
        for (let i = 0; i < room.players.length; i++) {
            spawns.push({ x: 150 + spacing * (i + 1), y: 200 });
        }

        const playerData = room.players.map((p, i) => ({
            id: p.id,
            name: p.name,
            weaponIdx: p.weaponIdx,
            spawnX: spawns[i].x,
            spawnY: spawns[i].y,
            color: ['#4af', '#f44', '#4f8', '#f6f', '#ff4', '#4ff', '#f88', '#84f'][i]
        }));

        io.to(currentRoom).emit('gameStart', {
            players: playerData,
            roundNum: room.roundNum,
            botCount: room.botCount || 0,
            botDiff: room.botDiff || 1
        });
        console.log(`Room ${currentRoom} game started (round ${room.roundNum})`);
    });

    // Game state update (player sends their state ~20fps)
    socket.on('state', (data) => {
        if (!currentRoom) return;
        socket.to(currentRoom).volatile.emit('state', {
            id: socket.id,
            ...data
        });
    });

    // Hit event (player hit another player)
    socket.on('hit', (data) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit('hit', {
            attackerId: socket.id,
            targetId: data.targetId,
            damage: data.damage,
            knockX: data.knockX,
            knockY: data.knockY,
            special: data.special || false
        });
    });

    // Player died
    socket.on('died', (data) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit('playerDied', {
            id: socket.id,
            killerId: data.killerId
        });
    });

    // Round end
    socket.on('roundEnd', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || room.host !== socket.id) return;
        room.state = 'lobby';
        io.to(currentRoom).emit('backToLobby');
    });

    // Chat
    socket.on('chat', (msg) => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const p = room.players.find(p => p.id === socket.id);
        const name = p ? p.name : '???';
        io.to(currentRoom).emit('chat', { name, msg: (msg || '').slice(0, 100) });
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;

        room.players = room.players.filter(p => p.id !== socket.id);
        io.to(currentRoom).emit('playerLeft', {
            id: socket.id,
            players: room.players.map(p => ({ id: p.id, name: p.name, weaponIdx: p.weaponIdx }))
        });

        // Transfer host
        if (room.host === socket.id && room.players.length > 0) {
            room.host = room.players[0].id;
            io.to(currentRoom).emit('newHost', { id: room.host });
        }

        cleanupRoom(currentRoom);
    });
});

// Room list (optional)
app.get('/api/rooms', (req, res) => {
    const list = [];
    rooms.forEach((room, code) => {
        if (room.state === 'lobby' && room.players.length < room.maxPlayers) {
            list.push({ code, players: room.players.length, max: room.maxPlayers, host: room.players[0]?.name });
        }
    });
    res.json(list);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Stickdown Arena server running on port ${PORT}`);
});

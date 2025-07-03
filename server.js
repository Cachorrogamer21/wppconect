const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Determinar ambiente (Vercel ou desenvolvimento local)
const isProduction = process.env.NODE_ENV === 'production';
const AUTH_FOLDER = isProduction ? '/tmp/auth_info' : path.join(__dirname, 'auth_info');

// Cria a pasta para armazenar os dados de autenticação se não existir
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        allowedHeaders: ['*'],
        credentials: true
    },
    transports: ['polling', 'websocket'], // Prioriza polling sobre WebSockets
    allowUpgrades: false, // Impede upgrade para WebSockets
    pingTimeout: 30000,
    pingInterval: 25000
});

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Rota de verificação de saúde
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', environment: isProduction ? 'production' : 'development' });
});

// Armazena as conexões ativas do WhatsApp
const connections = {};

// Função para iniciar uma conexão com o WhatsApp
async function startWhatsAppConnection(sessionId, socketId) {
    const sessionFolder = path.join(AUTH_FOLDER, sessionId);
    
    // Cria pasta da sessão se não existir
    if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true });
    }

    // Carrega estado de autenticação
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    
    // Logger
    const logger = P({ level: 'silent' });
    
    // Cria a conexão com o WhatsApp
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger,
        browser: ['WhatsApp Connector', 'Chrome', '4.0.0'],
    });

    // Gerencia eventos de conexão
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Gera QR Code quando disponível
        if (qr) {
            console.log('QR Code recebido, gerando imagem...');
            const qrCodeDataURL = await qrcode.toDataURL(qr);
            io.to(socketId).emit('qr', { qrCode: qrCodeDataURL });
        }

        if (connection === 'open') {
            console.log('Conexão aberta!');
            io.to(socketId).emit('connection-open', {
                user: sock.user,
                connected: true
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log('Conexão fechada. Código de status:', statusCode);
            io.to(socketId).emit('connection-close', {
                shouldReconnect,
                statusCode
            });
            
            if (shouldReconnect) {
                console.log('Tentando reconectar...');
                startWhatsAppConnection(sessionId, socketId);
            }
        }
    });

    // Salva credenciais quando atualizadas
    sock.ev.on('creds.update', saveCreds);
    
    // Gerencia eventos de mensagens
    sock.ev.on('messages.upsert', data => {
        console.log('Nova(s) mensagem(ns) recebida(s)');
        io.to(socketId).emit('messages', data);
    });
    
    // Armazena a conexão
    connections[sessionId] = sock;
    return sock;
}

// Rotas da API
app.get('/api/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const connection = connections[sessionId];
    
    if (connection) {
        res.json({ connected: true });
    } else {
        res.json({ connected: false });
    }
});

// Rota para enviar mensagens
app.post('/api/send-message/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const { number, message } = req.body;
    
    const connection = connections[sessionId];
    if (!connection) {
        return res.status(404).json({ success: false, message: 'Sessão não encontrada' });
    }
    
    try {
        // Formata número com @s.whatsapp.net
        const formattedNumber = `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        
        await connection.sendMessage(formattedNumber, { text: message });
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        res.status(500).json({ success: false, message: 'Erro ao enviar mensagem' });
    }
});

// Conexões WebSocket
io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);
    
    socket.on('start-session', async ({ sessionId }) => {
        console.log('Iniciando sessão:', sessionId);
        try {
            await startWhatsAppConnection(sessionId, socket.id);
            socket.emit('session-started', { success: true });
        } catch (error) {
            console.error('Erro ao iniciar sessão:', error);
            socket.emit('session-started', { success: false, error: error.message });
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
    });
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
}); 

// Exportar para Vercel
module.exports = app; 

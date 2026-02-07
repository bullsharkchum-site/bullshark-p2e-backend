require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=64ae06e8-606e-4e6d-8c79-bb210ae08977';
const CHUM_MINT = new PublicKey(process.env.CHUM_MINT || 'B9nLmgbkW9X59xvwne1Z7qfJ46AsAmNEydMiJrgxpump');
const MIN_HOLD_REQUIREMENT = parseInt(process.env.MIN_HOLD_REQUIREMENT || '25000'); // 25K $CHUM
const POINTS_PER_CHUM = 3000;

// Load authority keypair (optional for now)
let authority = null;
try {
    if (process.env.AUTHORITY_KEYPAIR) {
        const keypairData = JSON.parse(process.env.AUTHORITY_KEYPAIR);
        authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
        console.log('✅ Authority loaded:', authority.publicKey.toString());
    } else {
        console.log('⚠️ No authority keypair - P2E reward claiming disabled');
    }
} catch (error) {
    console.error('⚠️ Failed to load authority keypair - P2E reward claiming disabled');
}

const connection = new Connection(RPC_URL, 'confirmed');

// In-memory storage for game sessions (use database in production)
const gameSessions = new Map();
const playerRecords = new Map();

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        authority: authority ? authority.publicKey.toString() : 'Not configured',
        chumMint: CHUM_MINT.toString(),
        minHold: MIN_HOLD_REQUIREMENT,
        p2eEnabled: authority !== null,
        rpcUrl: RPC_URL.split('?')[0] // Hide API key
    });
});

// Debug endpoint
app.get('/api/debug/connection', async (req, res) => {
    try {
        const slot = await connection.getSlot();
        const blockTime = await connection.getBlockTime(slot);
        
        res.json({
            status: 'connected',
            rpcUrl: RPC_URL.split('?')[0],
            currentSlot: slot,
            blockTime: new Date(blockTime * 1000).toISOString(),
            chumMint: CHUM_MINT.toString(),
            minHold: MIN_HOLD_REQUIREMENT
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message,
            rpcUrl: RPC_URL.split('?')[0]
        });
    }
});

// Check player balance
app.get('/api/check-balance/:wallet', async (req, res) => {
    try {
        // Validate wallet address first
        let playerPubkey;
        try {
            playerPubkey = new PublicKey(req.params.wallet);
        } catch (e) {
            console.log(`❌ Invalid wallet address: ${req.params.wallet}`);
            return res.json({
                wallet: req.params.wallet,
                balance: 0,
                required: MIN_HOLD_REQUIREMENT,
                eligible: false,
                deficit: MIN_HOLD_REQUIREMENT,
                error: 'Invalid wallet address'
            });
        }

        const tokenAccount = await getAssociatedTokenAddress(
            CHUM_MINT,
            playerPubkey
        );
        
        // Check if token account exists first
        const accountInfo = await connection.getAccountInfo(tokenAccount);
        
        if (!accountInfo) {
            console.log(`⚠️ No $CHUM token account for ${req.params.wallet}`);
            return res.json({
                wallet: req.params.wallet,
                balance: 0,
                required: MIN_HOLD_REQUIREMENT,
                eligible: false,
                deficit: MIN_HOLD_REQUIREMENT,
                error: 'No $CHUM tokens found',
                message: 'This wallet has never received $CHUM tokens. Buy $CHUM first!'
            });
        }

        const balance = await connection.getTokenAccountBalance(tokenAccount);
        const chumBalance = balance.value.uiAmount || 0;
        
        const eligible = chumBalance >= MIN_HOLD_REQUIREMENT;
        const deficit = Math.max(0, MIN_HOLD_REQUIREMENT - chumBalance);
        
        console.log(`✅ Balance check: ${req.params.wallet.slice(0,4)}...${req.params.wallet.slice(-4)} = ${chumBalance.toLocaleString()} $CHUM (eligible: ${eligible})`);
        
        res.json({
            wallet: req.params.wallet,
            balance: chumBalance,
            required: MIN_HOLD_REQUIREMENT,
            eligible,
            deficit,
            decimals: balance.value.decimals,
            message: eligible 
                ? `✅ Eligible! You hold ${chumBalance.toLocaleString()} $CHUM`
                : `❌ Need ${deficit.toLocaleString()} more $CHUM (you have ${chumBalance.toLocaleString()})`
        });
    } catch (error) {
        console.error('❌ Balance check error:', error);
        res.status(500).json({
            wallet: req.params.wallet,
            balance: 0,
            required: MIN_HOLD_REQUIREMENT,
            eligible: false,
            deficit: MIN_HOLD_REQUIREMENT,
            error: `Failed to check balance: ${error.message}`
        });
    }
});

// Verify eligibility
app.post('/api/verify-eligibility', async (req, res) => {
    try {
        const { playerWallet } = req.body;
        
        if (!playerWallet) {
            return res.status(400).json({ error: 'Player wallet required' });
        }

        // Validate wallet address
        let playerPubkey;
        try {
            playerPubkey = new PublicKey(playerWallet);
        } catch (e) {
            return res.status(400).json({
                eligible: false,
                error: 'Invalid wallet address'
            });
        }

        const tokenAccount = await getAssociatedTokenAddress(
            CHUM_MINT,
            playerPubkey
        );
        
        // Check if token account exists
        const accountInfo = await connection.getAccountInfo(tokenAccount);
        
        if (!accountInfo) {
            console.log(`⚠️ No token account for ${playerWallet}`);
            return res.json({
                eligible: false,
                balance: 0,
                required: MIN_HOLD_REQUIREMENT,
                deficit: MIN_HOLD_REQUIREMENT,
                error: 'No $CHUM tokens found',
                message: 'This wallet has never received $CHUM. Buy $CHUM first!'
            });
        }
        
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        const chumBalance = balance.value.uiAmount || 0;
        
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            console.log(`❌ Insufficient balance: ${playerWallet} has ${chumBalance} $CHUM`);
            return res.json({
                eligible: false,
                balance: chumBalance,
                required: MIN_HOLD_REQUIREMENT,
                deficit: MIN_HOLD_REQUIREMENT - chumBalance,
                message: `Need ${(MIN_HOLD_REQUIREMENT - chumBalance).toLocaleString()} more $CHUM (you have ${chumBalance.toLocaleString()})`
            });
        }

        // Store player record
        playerRecords.set(playerWallet, {
            wallet: playerWallet,
            balance: chumBalance,
            verifiedAt: Date.now(),
            totalEarned: 0,
            totalClaimed: 0
        });

        console.log(`✅ Player verified: ${playerWallet.slice(0,4)}...${playerWallet.slice(-4)} with ${chumBalance.toLocaleString()} $CHUM`);
        
        res.json({
            eligible: true,
            balance: chumBalance,
            required: MIN_HOLD_REQUIREMENT,
            message: `✅ Verified! You hold ${chumBalance.toLocaleString()} $CHUM and can earn rewards!`
        });
    } catch (error) {
        console.error('❌ Verification error:', error);
        res.status(500).json({ 
            eligible: false,
            error: error.message 
        });
    }
});

// Claim rewards
app.post('/api/claim-rewards', async (req, res) => {
    try {
        const { playerWallet, points } = req.body;

        if (!playerWallet || !points) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        if (points < POINTS_PER_CHUM) {
            return res.status(400).json({
                error: 'Insufficient points',
                message: `Need at least ${POINTS_PER_CHUM.toLocaleString()} points to earn 1 $CHUM`
            });
        }

        // Validate wallet
        let playerPubkey;
        try {
            playerPubkey = new PublicKey(playerWallet);
        } catch (e) {
            return res.status(400).json({
                success: false,
                error: 'Invalid wallet address'
            });
        }

        // Check player is still eligible
        const tokenAccount = await getAssociatedTokenAddress(
            CHUM_MINT,
            playerPubkey
        );
        
        const accountInfo = await connection.getAccountInfo(tokenAccount);
        
        if (!accountInfo) {
            return res.json({
                success: false,
                error: 'NO_TOKEN_ACCOUNT',
                message: 'No $CHUM token account found'
            });
        }
        
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        const chumBalance = balance.value.uiAmount || 0;
        
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({
                success: false,
                error: 'INSUFFICIENT_BALANCE',
                balance: chumBalance,
                required: MIN_HOLD_REQUIREMENT,
                message: `You need at least ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM to earn rewards`
            });
        }

        // Calculate rewards
        const chumEarned = points / POINTS_PER_CHUM;
        const sessionId = Date.now();

        // Store session
        gameSessions.set(sessionId, {
            player: playerWallet,
            points,
            chumEarned,
            timestamp: sessionId,
            claimed: true
        });

        // Update player record
        const playerRecord = playerRecords.get(playerWallet) || {
            wallet: playerWallet,
            totalEarned: 0,
            totalClaimed: 0
        };
        
        playerRecord.totalEarned += chumEarned;
        playerRecord.totalClaimed += chumEarned;
        playerRecord.lastClaim = Date.now();
        playerRecords.set(playerWallet, playerRecord);

        console.log(`🎮 ${playerWallet.slice(0,4)}...${playerWallet.slice(-4)} earned ${chumEarned.toFixed(4)} $CHUM from ${points.toLocaleString()} points`);

        // TODO: Actually transfer tokens from PDA
        // For now, just return success
        
        res.json({
            success: true,
            signature: 'SIMULATED_TX_' + sessionId, // Replace with actual tx signature
            points,
            chumEarned: chumEarned.toFixed(4),
            sessionId,
            timestamp: Date.now(),
            message: `🦈 You earned ${chumEarned.toFixed(4)} $CHUM!`
        });
    } catch (error) {
        console.error('❌ Claim error:', error);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

// Get player stats
app.get('/api/player/:wallet', async (req, res) => {
    try {
        const record = playerRecords.get(req.params.wallet);
        
        if (!record) {
            return res.status(404).json({ 
                error: 'Player not found',
                message: 'Player has not verified yet'
            });
        }

        res.json(record);
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all sessions (admin)
app.get('/api/admin/sessions', (req, res) => {
    const { adminKey } = req.query;
    
    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const totalChumEarned = Array.from(gameSessions.values())
        .reduce((sum, session) => sum + session.chumEarned, 0);

    res.json({
        totalSessions: gameSessions.size,
        totalPlayers: playerRecords.size,
        totalChumEarned: totalChumEarned.toFixed(4),
        sessions: Array.from(gameSessions.values()).slice(-50) // Last 50 sessions
    });
});

const PORT = process.env.PORT || 3000;

// Only start server if not in Vercel serverless environment
if (process.env.VERCEL !== '1') {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🦈 BullShark P2E API running on port ${PORT}`);
        console.log(`📡 RPC: ${RPC_URL.split('?')[0]}`);
        console.log(`💎 $CHUM Mint: ${CHUM_MINT.toString()}`);
        console.log(`🎮 Min Hold: ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM`);
        console.log(`🎯 Conversion: ${POINTS_PER_CHUM.toLocaleString()} points = 1 $CHUM`);
    });
}

// Export for Vercel serverless
module.exports = app;

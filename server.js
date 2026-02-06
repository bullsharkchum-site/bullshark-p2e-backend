require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const CHUM_MINT = new PublicKey(process.env.CHUM_MINT);
const MIN_HOLD_REQUIREMENT = 25000; // 25K $CHUM
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
        minHold: MIN_HOLD_REQUIREMENT,
        p2eEnabled: authority !== null
    });
});

// Check player balance
app.get('/api/check-balance/:wallet', async (req, res) => {
    try {
        const playerPubkey = new PublicKey(req.params.wallet);
        const tokenAccount = await getAssociatedTokenAddress(
            CHUM_MINT,
            playerPubkey
        );
        
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        
        // Use the actual decimals from the token response
        const chumBalance = balance.value.uiAmount || 0;
        
        const eligible = chumBalance >= MIN_HOLD_REQUIREMENT;
        const deficit = Math.max(0, MIN_HOLD_REQUIREMENT - chumBalance);
        
        console.log(`Balance check for ${req.params.wallet}: ${chumBalance} $CHUM (decimals: ${balance.value.decimals})`);
        
        res.json({
            wallet: req.params.wallet,
            balance: chumBalance,
            required: MIN_HOLD_REQUIREMENT,
            eligible,
            deficit,
            decimals: balance.value.decimals,
            message: eligible 
                ? `✅ Eligible! You hold ${chumBalance.toFixed(2)} $CHUM`
                : `❌ Need ${deficit.toFixed(2)} more $CHUM`
        });
    } catch (error) {
        console.error('Balance check error:', error);
        res.json({
            wallet: req.params.wallet,
            balance: 0,
            required: MIN_HOLD_REQUIREMENT,
            eligible: false,
            deficit: MIN_HOLD_REQUIREMENT,
            error: 'No $CHUM token account found'
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

        const playerPubkey = new PublicKey(playerWallet);
        const tokenAccount = await getAssociatedTokenAddress(
            CHUM_MINT,
            playerPubkey
        );
        
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        const chumBalance = balance.value.uiAmount || 0;
        
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({
                eligible: false,
                balance: chumBalance,
                required: MIN_HOLD_REQUIREMENT,
                deficit: MIN_HOLD_REQUIREMENT - chumBalance,
                message: `Need ${(MIN_HOLD_REQUIREMENT - chumBalance).toFixed(2)} more $CHUM`
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

        console.log(`✅ Player verified: ${playerWallet} with ${chumBalance} $CHUM`);
        
        res.json({
            eligible: true,
            balance: chumBalance,
            message: `✅ Verified! You can earn $CHUM rewards`
        });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ error: error.message });
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
                message: `Need at least ${POINTS_PER_CHUM} points to earn 1 $CHUM`
            });
        }

        // Check player is still eligible
        const playerPubkey = new PublicKey(playerWallet);
        const tokenAccount = await getAssociatedTokenAddress(
            CHUM_MINT,
            playerPubkey
        );
        
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        const chumBalance = balance.value.uiAmount || 0;
        
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({
                success: false,
                error: 'INSUFFICIENT_BALANCE',
                message: `You need at least ${MIN_HOLD_REQUIREMENT} $CHUM to earn rewards`
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
        playerRecords.set(playerWallet, playerRecord);

        console.log(`🎮 ${playerWallet} earned ${chumEarned.toFixed(4)} $CHUM from ${points} points`);

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
        console.error('Claim error:', error);
        res.status(500).json({ error: error.message });
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

    res.json({
        totalSessions: gameSessions.size,
        totalPlayers: playerRecords.size,
        sessions: Array.from(gameSessions.values())
    });
});

const PORT = process.env.PORT || 3000;

// Only start server if not in Vercel serverless environment
if (process.env.VERCEL !== '1') {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🦈 BullShark P2E API running on port ${PORT}`);
        console.log(`📡 RPC: ${RPC_URL}`);
        console.log(`💎 Min Hold: ${MIN_HOLD_REQUIREMENT} $CHUM`);
        console.log(`🎮 Conversion: ${POINTS_PER_CHUM} points = 1 $CHUM`);
    });
}

// Export for Vercel serverless
module.exports = app;

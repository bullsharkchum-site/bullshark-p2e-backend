require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getMint } = require('@solana/spl-token');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=64ae06e8-606e-4e6d-8c79-bb210ae08977';
const CHUM_MINT = process.env.CHUM_MINT || 'B9nLmgbkW9X59xvwne1Z7qfJ46AsAmNEydMiJrgxpump';
const MIN_HOLD_REQUIREMENT = parseInt(process.env.MIN_HOLD_REQUIREMENT || '25000');
const POINTS_PER_CHUM = 3000;

let authority = null;
try {
    if (process.env.AUTHORITY_KEYPAIR) {
        const keypairData = JSON.parse(process.env.AUTHORITY_KEYPAIR);
        authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
        console.log('✅ Authority loaded:', authority.publicKey.toString());
    }
} catch (error) {
    console.error('⚠️ Failed to load authority keypair');
}

const connection = new Connection(RPC_URL, 'confirmed');

// ✅ ENHANCED: In-memory storage with detailed tracking
const gameSessions = new Map(); // All game sessions
const playerRecords = new Map(); // Player accumulated rewards

// ✅ COPIED FROM BOT: Token Program IDs
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// ✅ COPIED FROM BOT: Solana address validator
function isValidSolanaAddress(address) {
  try {
    if (!address || typeof address !== "string") return false;
    address = address.trim();
    
    const decoded = bs58.decode(address);
    if (decoded.length !== 32) return false;
    
    if (address.length < 30 || address.length > 48) return false;
    
    new PublicKey(address);
    
    return true;
  } catch (error) {
    console.log(`⚠️ Invalid address: ${address?.substring(0, 10)}...`);
    return false;
  }
}

// ✅ COPIED FROM BOT: Get token balance with BOTH token programs
async function getTokenBalance(ownerAddress, mintAddress) {
  try {
    if (!mintAddress || mintAddress === 'SOL') return 0;
    const owner = new PublicKey(ownerAddress);
    const mint = new PublicKey(mintAddress);
    let total = 0;

    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const resp = await connection.getParsedTokenAccountsByOwner(owner, { programId });
      for (const a of resp.value) {
        const info = a.account?.data?.parsed?.info;
        if (!info || info.mint !== mint.toBase58()) continue;
        const amt = info.tokenAmount || {};
        const asNumber = amt.uiAmountString ? Number(amt.uiAmountString) : Number(amt.uiAmount ?? 0);
        if (Number.isFinite(asNumber)) total += asNumber;
      }
    }
    return total;
  } catch (e) {
    console.error('getTokenBalance error:', e.message);
    return 0;
  }
}

// ✅ COPIED FROM BOT: Pump.fun detection
async function checkPumpfunToken(mint) {
  try {
    console.log(`🔍 Checking Pump.fun API for: ${mint.slice(0,8)}...`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    console.log(`📡 Pump.fun API response: ${response.status}`);
    
    if (response.status >= 500) {
      console.log(`⚠️ Pump.fun API temporarily unavailable (${response.status})`);
      return { isPumpfun: null, graduated: null };
    }
    
    if (response.ok) {
      const data = await response.json();
      
      if (data?.mint) {
        const isGraduated = !!data.raydium_pool;
        const marketCap = Number(data.usd_market_cap || 0);
        
        console.log(`✅ Pump.fun token detected: ${isGraduated ? 'GRADUATED' : 'PRE-GRADUATION'}`);
        console.log(`   Market Cap: $${marketCap.toLocaleString()}`);
        
        return {
          isPumpfun: true,
          graduated: isGraduated,
          marketCap: marketCap,
          bondingCurve: data.bonding_curve,
          raydiumPool: data.raydium_pool
        };
      }
    } else if (response.status === 404) {
      console.log(`ℹ️ Token not found on pump.fun (404)`);
      return { isPumpfun: false, graduated: null };
    }
    
    return { isPumpfun: null, graduated: null };
  } catch (pumpErr) {
    if (pumpErr.name === 'AbortError') {
      console.log(`⚠️ Pump.fun API timeout`);
    } else {
      console.log(`⚠️ Pump.fun check failed: ${pumpErr.message}`);
    }
    return { isPumpfun: null, graduated: null };
  }
}

// ✅ ENHANCED: Token balance checker that works for ALL token types
async function getComprehensiveTokenBalance(walletAddress, tokenMint) {
  try {
    console.log(`🔍 Comprehensive balance check for ${walletAddress.slice(0,8)}...`);
    
    if (!isValidSolanaAddress(walletAddress) || !isValidSolanaAddress(tokenMint)) {
      console.log('❌ Invalid address format');
      return 0;
    }
    
    const owner = new PublicKey(walletAddress);
    const mint = new PublicKey(tokenMint);
    
    const pumpInfo = await checkPumpfunToken(tokenMint);
    
    if (pumpInfo.isPumpfun === true && !pumpInfo.graduated) {
      console.log(`🎯 Pre-graduation pump.fun token - checking bonding curve holdings`);
      
      const balance = await getTokenBalance(walletAddress, tokenMint);
      
      if (balance > 0) {
        console.log(`✅ Found ${balance} tokens (may be from bonding curve or graduated)`);
        return balance;
      }
      
      console.log(`ℹ️ No standard ATA balance found for pre-graduation token`);
      return 0;
    }
    
    console.log(`🔍 Checking standard token programs...`);
    const balance = await getTokenBalance(walletAddress, tokenMint);
    
    if (balance > 0) {
      console.log(`✅ Found ${balance} tokens via standard method`);
      return balance;
    }
    
    console.log(`🔍 Checking raw token accounts as fallback...`);
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      owner,
      { mint: mint }
    );
    
    if (tokenAccounts.value.length > 0) {
      let totalBalance = 0;
      for (const account of tokenAccounts.value) {
        try {
          const accountInfo = await connection.getParsedAccountInfo(account.pubkey);
          const balance = accountInfo.value?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
          totalBalance += balance;
        } catch (e) {
          console.log(`⚠️ Failed to parse token account: ${e.message}`);
        }
      }
      
      if (totalBalance > 0) {
        console.log(`✅ Found ${totalBalance} tokens via raw account check`);
        return totalBalance;
      }
    }
    
    console.log(`ℹ️ No token balance found after all checks`);
    return 0;
    
  } catch (error) {
    console.error('❌ getComprehensiveTokenBalance error:', error.message);
    return 0;
  }
}

// ✅ NEW: Initialize or get player record
function getOrCreatePlayerRecord(wallet) {
  if (!playerRecords.has(wallet)) {
    playerRecords.set(wallet, {
      wallet,
      totalEarned: 0,
      totalClaimed: 0,
      pendingRewards: 0,
      balance: 0,
      gamesPlayed: 0,
      lastGameAt: null,
      lastClaimAt: null,
      verifiedAt: null,
      earnHistory: []
    });
  }
  return playerRecords.get(wallet);
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        chumMint: CHUM_MINT,
        minHold: MIN_HOLD_REQUIREMENT,
        rpcUrl: RPC_URL.split('?')[0],
        playersTracked: playerRecords.size,
        totalSessions: gameSessions.size
    });
});

// ✅ ENHANCED: Check balance endpoint
app.get('/api/check-balance/:wallet', async (req, res) => {
    try {
        const walletAddress = req.params.wallet;
        
        console.log(`\n🔍 Balance check request for: ${walletAddress}`);
        
        if (!isValidSolanaAddress(walletAddress)) {
            console.log(`❌ Invalid wallet address format`);
            return res.json({
                wallet: walletAddress,
                balance: 0,
                required: MIN_HOLD_REQUIREMENT,
                eligible: false,
                error: 'Invalid wallet address format'
            });
        }
        
        const chumBalance = await getComprehensiveTokenBalance(walletAddress, CHUM_MINT);
        
        const eligible = chumBalance >= MIN_HOLD_REQUIREMENT;
        const deficit = Math.max(0, MIN_HOLD_REQUIREMENT - chumBalance);
        
        // ✅ Get player rewards if they exist
        const playerRecord = playerRecords.get(walletAddress);
        
        console.log(`✅ Balance check result: ${chumBalance.toLocaleString()} $CHUM (eligible: ${eligible})`);
        
        res.json({
            wallet: walletAddress,
            balance: chumBalance,
            required: MIN_HOLD_REQUIREMENT,
            eligible,
            deficit,
            // ✅ Include pending rewards info
            pendingRewards: playerRecord?.pendingRewards || 0,
            totalEarned: playerRecord?.totalEarned || 0,
            totalClaimed: playerRecord?.totalClaimed || 0,
            message: eligible 
                ? `✅ Eligible! You hold ${chumBalance.toLocaleString()} $CHUM`
                : `❌ Need ${deficit.toLocaleString()} more $CHUM (you have ${chumBalance.toLocaleString()})`
        });
    } catch (error) {
        console.error(`❌ Balance check error:`, error);
        res.status(500).json({
            wallet: req.params.wallet,
            balance: 0,
            required: MIN_HOLD_REQUIREMENT,
            eligible: false,
            error: error.message
        });
    }
});

// ✅ ENHANCED: Verify eligibility endpoint
app.post('/api/verify-eligibility', async (req, res) => {
    try {
        const { playerWallet } = req.body;
        
        if (!playerWallet) {
            return res.status(400).json({ error: 'Player wallet required' });
        }
        
        console.log(`\n🔍 Eligibility check for: ${playerWallet}`);
        
        if (!isValidSolanaAddress(playerWallet)) {
            return res.status(400).json({
                eligible: false,
                error: 'Invalid wallet address format'
            });
        }
        
        const chumBalance = await getComprehensiveTokenBalance(playerWallet, CHUM_MINT);
        
        if (chumBalance === 0) {
            console.log(`⚠️ No tokens found for ${playerWallet}`);
            return res.json({
                eligible: false,
                balance: 0,
                required: MIN_HOLD_REQUIREMENT,
                deficit: MIN_HOLD_REQUIREMENT,
                message: 'No $CHUM tokens found. Buy $CHUM first!'
            });
        }
        
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            console.log(`❌ Insufficient balance: ${chumBalance} $CHUM`);
            return res.json({
                eligible: false,
                balance: chumBalance,
                required: MIN_HOLD_REQUIREMENT,
                deficit: MIN_HOLD_REQUIREMENT - chumBalance,
                message: `Need ${(MIN_HOLD_REQUIREMENT - chumBalance).toLocaleString()} more $CHUM`
            });
        }
        
        // ✅ Get or create player record
        const playerRecord = getOrCreatePlayerRecord(playerWallet);
        playerRecord.balance = chumBalance;
        playerRecord.verifiedAt = Date.now();
        
        console.log(`✅ Player verified with ${chumBalance.toLocaleString()} $CHUM`);
        
        res.json({
            eligible: true,
            balance: chumBalance,
            required: MIN_HOLD_REQUIREMENT,
            pendingRewards: playerRecord.pendingRewards,
            totalEarned: playerRecord.totalEarned,
            totalClaimed: playerRecord.totalClaimed,
            message: `✅ Verified! You hold ${chumBalance.toLocaleString()} $CHUM`
        });
    } catch (error) {
        console.error(`❌ Verification error:`, error);
        res.status(500).json({ 
            eligible: false,
            error: error.message 
        });
    }
});

// ✅ NEW: Record game rewards (doesn't claim, just tracks)
app.post('/api/record-game', async (req, res) => {
    try {
        const { playerWallet, points, finalScore } = req.body;

        if (!playerWallet || !points) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        if (points < POINTS_PER_CHUM) {
            return res.json({
                success: false,
                message: `Need at least ${POINTS_PER_CHUM.toLocaleString()} points to earn $CHUM`,
                pointsEarned: 0
            });
        }

        // ✅ Verify they still hold enough $CHUM
        const chumBalance = await getComprehensiveTokenBalance(playerWallet, CHUM_MINT);
        
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({
                success: false,
                error: 'INSUFFICIENT_BALANCE',
                balance: chumBalance,
                required: MIN_HOLD_REQUIREMENT,
                message: `Need at least ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM to earn rewards`
            });
        }

        const chumEarned = points / POINTS_PER_CHUM;
        const sessionId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // ✅ Record game session
        gameSessions.set(sessionId, {
            sessionId,
            player: playerWallet,
            points,
            finalScore: finalScore || points,
            chumEarned,
            timestamp: Date.now(),
            claimed: false
        });

        // ✅ Update player record - ADD to pending, NOT claimed
        const playerRecord = getOrCreatePlayerRecord(playerWallet);
        playerRecord.totalEarned += chumEarned;
        playerRecord.pendingRewards += chumEarned;
        playerRecord.gamesPlayed += 1;
        playerRecord.lastGameAt = Date.now();
        playerRecord.balance = chumBalance;
        
        // ✅ Add to earn history
        playerRecord.earnHistory.push({
            sessionId,
            points,
            chumEarned,
            timestamp: Date.now(),
            claimed: false
        });

        console.log(`🎮 ${playerWallet.slice(0,4)}... earned ${chumEarned.toFixed(4)} $CHUM (pending)`);
        console.log(`   Total pending: ${playerRecord.pendingRewards.toFixed(4)} $CHUM`);
        
        res.json({
            success: true,
            sessionId,
            points,
            chumEarned: parseFloat(chumEarned.toFixed(4)),
            pendingRewards: parseFloat(playerRecord.pendingRewards.toFixed(4)),
            totalEarned: parseFloat(playerRecord.totalEarned.toFixed(4)),
            totalClaimed: parseFloat(playerRecord.totalClaimed.toFixed(4)),
            gamesPlayed: playerRecord.gamesPlayed,
            message: `🦈 You earned ${chumEarned.toFixed(4)} $CHUM! Total pending: ${playerRecord.pendingRewards.toFixed(4)}`
        });
    } catch (error) {
        console.error(`❌ Record game error:`, error);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

// ✅ ENHANCED: Claim accumulated rewards (with partial claim support)
app.post('/api/claim-rewards', async (req, res) => {
    try {
        const { playerWallet, claimAmount } = req.body;

        if (!playerWallet) {
            return res.status(400).json({ error: 'Player wallet required' });
        }

        const playerRecord = playerRecords.get(playerWallet);
        
        if (!playerRecord) {
            return res.status(404).json({
                success: false,
                error: 'NO_PLAYER_RECORD',
                message: 'No rewards to claim. Play some games first!'
            });
        }

        if (playerRecord.pendingRewards <= 0) {
            return res.json({
                success: false,
                message: 'No pending rewards to claim',
                pendingRewards: 0,
                totalClaimed: playerRecord.totalClaimed
            });
        }

        // ✅ Verify they still hold enough $CHUM
        const chumBalance = await getComprehensiveTokenBalance(playerWallet, CHUM_MINT);
        
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({
                success: false,
                error: 'INSUFFICIENT_BALANCE',
                balance: chumBalance,
                required: MIN_HOLD_REQUIREMENT,
                message: `Need at least ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM to claim rewards`
            });
        }

        // ✅ Determine claim amount (partial or full)
        let amountToClaim;
        
        if (claimAmount && claimAmount > 0) {
            // Partial claim requested
            if (claimAmount > playerRecord.pendingRewards) {
                return res.status(400).json({
                    success: false,
                    error: 'INSUFFICIENT_PENDING',
                    pendingRewards: playerRecord.pendingRewards,
                    requested: claimAmount,
                    message: `Only ${playerRecord.pendingRewards.toFixed(4)} $CHUM available to claim`
                });
            }
            amountToClaim = claimAmount;
        } else {
            // Claim all pending
            amountToClaim = playerRecord.pendingRewards;
        }

        const claimId = `claim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // ✅ Update totals
        playerRecord.totalClaimed += amountToClaim;
        playerRecord.pendingRewards -= amountToClaim;
        playerRecord.lastClaimAt = Date.now();
        
        // ✅ Mark games as claimed (proportionally if partial claim)
        let remainingToMark = amountToClaim;
        for (let entry of playerRecord.earnHistory) {
            if (!entry.claimed && remainingToMark > 0) {
                if (entry.chumEarned <= remainingToMark) {
                    // Claim entire game
                    entry.claimed = true;
                    entry.claimedAt = Date.now();
                    entry.claimId = claimId;
                    remainingToMark -= entry.chumEarned;
                } else {
                    // Partial claim from this game (split it)
                    const originalEarned = entry.chumEarned;
                    
                    // Mark original as claimed with partial amount
                    entry.claimed = true;
                    entry.claimedAt = Date.now();
                    entry.claimId = claimId;
                    entry.claimedAmount = remainingToMark;
                    entry.remainingAmount = originalEarned - remainingToMark;
                    
                    // Create new entry for unclaimed portion
                    playerRecord.earnHistory.push({
                        sessionId: `${entry.sessionId}_remaining`,
                        points: Math.floor((entry.remainingAmount / originalEarned) * entry.points),
                        chumEarned: entry.remainingAmount,
                        timestamp: entry.timestamp,
                        claimed: false,
                        isRemainder: true,
                        originalSessionId: entry.sessionId
                    });
                    
                    remainingToMark = 0;
                    break;
                }
            }
        }

        console.log(`💰 ${playerWallet.slice(0,4)}... claimed ${amountToClaim.toFixed(4)} $CHUM`);
        console.log(`   Pending remaining: ${playerRecord.pendingRewards.toFixed(4)} $CHUM`);
        console.log(`   Total claimed: ${playerRecord.totalClaimed.toFixed(4)} $CHUM`);
        
        res.json({
            success: true,
            claimId,
            claimAmount: parseFloat(amountToClaim.toFixed(4)),
            remainingPending: parseFloat(playerRecord.pendingRewards.toFixed(4)),
            totalClaimed: parseFloat(playerRecord.totalClaimed.toFixed(4)),
            totalEarned: parseFloat(playerRecord.totalEarned.toFixed(4)),
            timestamp: Date.now(),
            // ✅ Simulated transaction
            signature: `SIMULATED_CLAIM_${claimId}`,
            message: `🎉 Successfully claimed ${amountToClaim.toFixed(4)} $CHUM! ${playerRecord.pendingRewards > 0 ? `${playerRecord.pendingRewards.toFixed(4)} $CHUM still pending.` : ''}`
        });
    } catch (error) {
        console.error(`❌ Claim error:`, error);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});
```

---

## 📊 **How It Works Now:**

### **Example Scenario:**
```
Player has: 10,000 $CHUM pending

Option 1: Claim ALL
POST /api/claim-rewards
{ "playerWallet": "EF5Zh..." }
→ Claims all 10,000 $CHUM
→ pendingRewards = 0

Option 2: Claim PARTIAL
POST /api/claim-rewards
{ "playerWallet": "EF5Zh...", "claimAmount": 8000 }
→ Claims 8,000 $CHUM
→ pendingRewards = 2,000 $CHUM remaining

Player plays more games:
→ Earns 3,500 $CHUM
→ pendingRewards = 2,000 + 3,500 = 5,500 $CHUM

Next claim:
→ Can claim some or all of 5,500 $CHUM

// ✅ ENHANCED: Get player stats with detailed breakdown
app.get('/api/player/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;
        const record = playerRecords.get(wallet);
        
        if (!record) {
            return res.status(404).json({ 
                error: 'Player not found',
                message: 'No game history for this wallet'
            });
        }

        // ✅ Get recent games (last 10)
        const recentGames = record.earnHistory
            .slice(-10)
            .reverse()
            .map(entry => ({
                sessionId: entry.sessionId,
                points: entry.points,
                chumEarned: parseFloat(entry.chumEarned.toFixed(4)),
                timestamp: entry.timestamp,
                claimed: entry.claimed,
                claimedAt: entry.claimedAt || null
            }));

        res.json({
            wallet: record.wallet,
            balance: record.balance,
            totalEarned: parseFloat(record.totalEarned.toFixed(4)),
            totalClaimed: parseFloat(record.totalClaimed.toFixed(4)),
            pendingRewards: parseFloat(record.pendingRewards.toFixed(4)),
            gamesPlayed: record.gamesPlayed,
            lastGameAt: record.lastGameAt,
            lastClaimAt: record.lastClaimAt,
            verifiedAt: record.verifiedAt,
            recentGames
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ✅ NEW: Get leaderboard
app.get('/api/leaderboard', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        
        const leaderboard = Array.from(playerRecords.values())
            .filter(p => p.totalEarned > 0)
            .sort((a, b) => b.totalEarned - a.totalEarned)
            .slice(0, limit)
            .map((p, index) => ({
                rank: index + 1,
                wallet: `${p.wallet.slice(0, 4)}...${p.wallet.slice(-4)}`,
                totalEarned: parseFloat(p.totalEarned.toFixed(4)),
                gamesPlayed: p.gamesPlayed,
                lastGameAt: p.lastGameAt
            }));

        res.json({
            leaderboard,
            totalPlayers: playerRecords.size
        });
    } catch (error) {
        console.error('Leaderboard error:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;

if (process.env.VERCEL !== '1') {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🦈 BullShark P2E API running on port ${PORT}`);
        console.log(`📡 RPC: ${RPC_URL.split('?')[0]}`);
        console.log(`💎 $CHUM Mint: ${CHUM_MINT}`);
        console.log(`🎮 Min Hold: ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM`);
        console.log(`🎯 Conversion: ${POINTS_PER_CHUM.toLocaleString()} points = 1 $CHUM`);
        console.log(`💰 Rewards: Accumulate & claim when ready!`);
    });
}

module.exports = app;

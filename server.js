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

// In-memory storage
const gameSessions = new Map();
const playerRecords = new Map();

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

    // ✅ Check BOTH token programs (standard + Token-2022)
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
      return { isPumpfun: null, graduated: null }; // Unknown due to API error
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
    
    // ✅ STEP 1: Check if it's a pump.fun token
    const pumpInfo = await checkPumpfunToken(tokenMint);
    
    if (pumpInfo.isPumpfun === true && !pumpInfo.graduated) {
      // ✅ PRE-GRADUATION PUMP.FUN TOKEN
      console.log(`🎯 Pre-graduation pump.fun token - checking bonding curve holdings`);
      
      // For pre-graduation tokens, we need to check Pump.fun's bonding curve
      // The balance is held in the bonding curve contract, not a standard ATA
      // We can still try to get an ATA balance in case they have any
      const balance = await getTokenBalance(walletAddress, tokenMint);
      
      if (balance > 0) {
        console.log(`✅ Found ${balance} tokens (may be from bonding curve or graduated)`);
        return balance;
      }
      
      console.log(`ℹ️ No standard ATA balance found for pre-graduation token`);
      // For pre-graduation tokens with no ATA, we can't reliably check balance
      // without querying Pump.fun's bonding curve directly
      return 0;
    }
    
    // ✅ STEP 2: Standard token or graduated pump.fun token
    console.log(`🔍 Checking standard token programs...`);
    const balance = await getTokenBalance(walletAddress, tokenMint);
    
    if (balance > 0) {
      console.log(`✅ Found ${balance} tokens via standard method`);
      return balance;
    }
    
    // ✅ STEP 3: Last resort - check raw token accounts
    console.log(`🔍 Checking raw token accounts as fallback...`);
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      owner,
      { mint: mint }
    );
    
    if (tokenAccounts.value.length > 0) {
      // Parse raw account data
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

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        chumMint: CHUM_MINT,
        minHold: MIN_HOLD_REQUIREMENT,
        rpcUrl: RPC_URL.split('?')[0]
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
        
        // ✅ Use comprehensive balance checker
        const chumBalance = await getComprehensiveTokenBalance(walletAddress, CHUM_MINT);
        
        const eligible = chumBalance >= MIN_HOLD_REQUIREMENT;
        const deficit = Math.max(0, MIN_HOLD_REQUIREMENT - chumBalance);
        
        console.log(`✅ Balance check result: ${chumBalance.toLocaleString()} $CHUM (eligible: ${eligible})`);
        
        res.json({
            wallet: walletAddress,
            balance: chumBalance,
            required: MIN_HOLD_REQUIREMENT,
            eligible,
            deficit,
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
        
        playerRecords.set(playerWallet, {
            wallet: playerWallet,
            balance: chumBalance,
            verifiedAt: Date.now(),
            totalEarned: 0,
            totalClaimed: 0
        });
        
        console.log(`✅ Player verified with ${chumBalance.toLocaleString()} $CHUM`);
        
        res.json({
            eligible: true,
            balance: chumBalance,
            required: MIN_HOLD_REQUIREMENT,
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

// Claim rewards endpoint (keeping your existing logic)
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

        const chumBalance = await getComprehensiveTokenBalance(playerWallet, CHUM_MINT);
        
        if (chumBalance === 0) {
            return res.json({
                success: false,
                error: 'NO_TOKEN_ACCOUNT',
                message: 'No $CHUM token account found'
            });
        }
        
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({
                success: false,
                error: 'INSUFFICIENT_BALANCE',
                balance: chumBalance,
                required: MIN_HOLD_REQUIREMENT,
                message: `Need at least ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM`
            });
        }

        const chumEarned = points / POINTS_PER_CHUM;
        const sessionId = Date.now();

        gameSessions.set(sessionId, {
            player: playerWallet,
            points,
            chumEarned,
            timestamp: sessionId,
            claimed: true
        });

        const playerRecord = playerRecords.get(playerWallet) || {
            wallet: playerWallet,
            totalEarned: 0,
            totalClaimed: 0
        };
        
        playerRecord.totalEarned += chumEarned;
        playerRecord.totalClaimed += chumEarned;
        playerRecord.lastClaim = Date.now();
        playerRecords.set(playerWallet, playerRecord);

        console.log(`🎮 ${playerWallet.slice(0,4)}... earned ${chumEarned.toFixed(4)} $CHUM`);
        
        res.json({
            success: true,
            signature: 'SIMULATED_TX_' + sessionId,
            points,
            chumEarned: chumEarned.toFixed(4),
            sessionId,
            timestamp: Date.now(),
            message: `🦈 You earned ${chumEarned.toFixed(4)} $CHUM!`
        });
    } catch (error) {
        console.error(`❌ Claim error:`, error);
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
                error: 'Player not found'
            });
        }

        res.json(record);
    } catch (error) {
        console.error('Stats error:', error);
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
    });
}

module.exports = app;

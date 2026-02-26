require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { 
  getAssociatedTokenAddress, 
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getMint,
  getAccount,
  TOKEN_PROGRAM_ID: SPL_TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=64ae06e8-606e-4e6d-8c79-bb210ae08977';
const CHUM_MINT = process.env.CHUM_MINT || 'B9nLmgbkW9X59xvwne1Z7qfJ46AsAmNEydMiJrgxpump';
const MIN_HOLD_REQUIREMENT = parseInt(process.env.MIN_HOLD_REQUIREMENT || '25000');
const ADMIN_KEY = process.env.ADMIN_KEY || 'bullshark2025admin';
const POINTS_PER_CHUM = 1000; // Updated: 1,000 pts = 1 $CHUM

// Token Program IDs for balance checking
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Load authority keypair
let authority = null;
try {
    if (process.env.AUTHORITY_KEYPAIR) {
        const keypairData = JSON.parse(process.env.AUTHORITY_KEYPAIR);
        authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
        console.log('✅ Authority loaded:', authority.publicKey.toString());
    } else {
        console.error('⚠️ AUTHORITY_KEYPAIR not set in environment variables!');
        console.error('   Generate one with: solana-keygen new --outfile authority.json');
        console.error('   Then set AUTHORITY_KEYPAIR to the JSON array contents');
    }
} catch (error) {
    console.error('⚠️ Failed to load authority keypair:', error.message);
}

const connection = new Connection(RPC_URL, 'confirmed');

// ===== FIREBASE PERSISTENT STORAGE =====
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://bullshark-game-default-rtdb.firebaseio.com';

// In-memory cache (backed by Firebase)
const gameSessions = new Map();
const playerRecords = new Map();

// Firebase REST API helpers
async function firebaseSave(path, data) {
  if (!FIREBASE_DB_URL) {
    console.warn('⚠️ FIREBASE_DB_URL not set — data will NOT persist across restarts!');
    return;
  }
  try {
    const url = `${FIREBASE_DB_URL}/p2e/${path}.json`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      console.error(`Firebase save error (${path}):`, response.statusText);
    }
  } catch (err) {
    console.error(`Firebase save error (${path}):`, err.message);
  }
}

async function firebaseLoad(path) {
  if (!FIREBASE_DB_URL) return null;
  try {
    const url = `${FIREBASE_DB_URL}/p2e/${path}.json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data;
  } catch (err) {
    console.error(`Firebase load error (${path}):`, err.message);
    return null;
  }
}

// Save player record to both cache and Firebase
async function savePlayerRecord(wallet, record) {
  playerRecords.set(wallet, record);
  // Save to Firebase (async, don't block the response)
  // Limit earnHistory to last 200 entries to keep Firebase manageable
  const toSave = { ...record };
  if (toSave.earnHistory && toSave.earnHistory.length > 200) {
    toSave.earnHistory = toSave.earnHistory.slice(-200);
  }
  firebaseSave(`players/${wallet}`, toSave);
}

// Load player from cache or Firebase
async function loadPlayerRecord(wallet) {
  // Check cache first
  if (playerRecords.has(wallet)) {
    return playerRecords.get(wallet);
  }
  // Try Firebase
  const data = await firebaseLoad(`players/${wallet}`);
  if (data) {
    // Ensure earnHistory is an array (Firebase can convert arrays to objects)
    if (data.earnHistory && !Array.isArray(data.earnHistory)) {
      data.earnHistory = Object.values(data.earnHistory);
    }
    playerRecords.set(wallet, data);
    return data;
  }
  return null;
}

// Load all players from Firebase on startup
async function loadAllPlayersFromFirebase() {
  if (!FIREBASE_DB_URL) {
    console.log('⚠️ No FIREBASE_DB_URL — running with in-memory only (data lost on restart)');
    return;
  }
  console.log('📂 Loading player data from Firebase...');
  try {
    const allPlayers = await firebaseLoad('players');
    if (allPlayers && typeof allPlayers === 'object') {
      let count = 0;
      for (const [wallet, record] of Object.entries(allPlayers)) {
        // Ensure earnHistory is an array
        if (record.earnHistory && !Array.isArray(record.earnHistory)) {
          record.earnHistory = Object.values(record.earnHistory);
        }
        if (!record.earnHistory) record.earnHistory = [];
        playerRecords.set(wallet, record);
        count++;
      }
      console.log(`✅ Loaded ${count} player records from Firebase`);
    } else {
      console.log('📂 No existing player data in Firebase');
    }
  } catch (err) {
    console.error('❌ Failed to load from Firebase:', err.message);
  }
}

// Start loading immediately
loadAllPlayersFromFirebase();

// ===== HELPER FUNCTIONS =====

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
    return false;
  }
}

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

async function checkPumpfunToken(mint) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (response.status >= 500) return { isPumpfun: null, graduated: null };
    if (response.ok) {
      const data = await response.json();
      if (data?.mint) {
        return {
          isPumpfun: true,
          graduated: !!data.raydium_pool,
          marketCap: Number(data.usd_market_cap || 0),
          bondingCurve: data.bonding_curve,
          raydiumPool: data.raydium_pool
        };
      }
    } else if (response.status === 404) {
      return { isPumpfun: false, graduated: null };
    }
    return { isPumpfun: null, graduated: null };
  } catch (pumpErr) {
    return { isPumpfun: null, graduated: null };
  }
}

async function getComprehensiveTokenBalance(walletAddress, tokenMint) {
  try {
    if (!isValidSolanaAddress(walletAddress) || !isValidSolanaAddress(tokenMint)) return 0;
    const owner = new PublicKey(walletAddress);
    const mint = new PublicKey(tokenMint);
    const pumpInfo = await checkPumpfunToken(tokenMint);
    
    if (pumpInfo.isPumpfun === true && !pumpInfo.graduated) {
      const balance = await getTokenBalance(walletAddress, tokenMint);
      return balance;
    }
    
    const balance = await getTokenBalance(walletAddress, tokenMint);
    if (balance > 0) return balance;
    
    const tokenAccounts = await connection.getTokenAccountsByOwner(owner, { mint });
    if (tokenAccounts.value.length > 0) {
      let totalBalance = 0;
      for (const account of tokenAccounts.value) {
        try {
          const accountInfo = await connection.getParsedAccountInfo(account.pubkey);
          const bal = accountInfo.value?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
          totalBalance += bal;
        } catch (e) {}
      }
      return totalBalance;
    }
    return 0;
  } catch (error) {
    console.error('getComprehensiveTokenBalance error:', error.message);
    return 0;
  }
}

async function getOrCreatePlayerRecord(wallet) {
  // Check cache first, then Firebase
  const existing = await loadPlayerRecord(wallet);
  if (existing) return existing;

  // Create new record
  const newRecord = {
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
  };
  playerRecords.set(wallet, newRecord);
  await savePlayerRecord(wallet, newRecord);
  return newRecord;
}

// ===== FIND ACTUAL TOKEN ACCOUNT (handles pump.fun non-standard ATAs) =====

async function findTokenAccount(ownerAddress, mintAddress) {
  const owner = new PublicKey(ownerAddress);
  const mint = new PublicKey(mintAddress);
  
  // Try both token programs
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const resp = await connection.getParsedTokenAccountsByOwner(owner, { programId });
      for (const a of resp.value) {
        const info = a.account?.data?.parsed?.info;
        if (!info || info.mint !== mint.toBase58()) continue;
        const amt = info.tokenAmount || {};
        const uiAmount = amt.uiAmountString ? Number(amt.uiAmountString) : Number(amt.uiAmount ?? 0);
        const rawAmount = BigInt(amt.amount || '0');
        if (rawAmount > 0n) {
          return {
            address: a.pubkey,
            balance: uiAmount,
            rawBalance: rawAmount,
            decimals: amt.decimals || 6,
            programId: programId
          };
        }
      }
    } catch (e) {
      console.log(`⚠️ findTokenAccount error for program ${programId.toString().slice(0,8)}: ${e.message}`);
    }
  }
  return null;
}

// ===== VAULT INFO HELPER =====

async function getVaultInfo() {
  if (!authority) return { funded: false, error: 'Authority keypair not loaded' };
  
  try {
    const tokenAccount = await findTokenAccount(authority.publicKey.toString(), CHUM_MINT);
    const mint = new PublicKey(CHUM_MINT);
    const standardAta = await getAssociatedTokenAddress(mint, authority.publicKey);
    
    return {
      funded: tokenAccount ? tokenAccount.balance > 0 : false,
      vaultBalance: tokenAccount ? tokenAccount.balance : 0,
      authorityWallet: authority.publicKey.toString(),
      authorityAta: standardAta.toString(),
      actualTokenAccount: tokenAccount ? tokenAccount.address.toString() : null,
      tokenProgram: tokenAccount ? tokenAccount.programId.toString() : null,
      mint: CHUM_MINT
    };
  } catch (error) {
    return { funded: false, error: error.message };
  }
}

// ===== ROUTES =====

// Health check
app.get('/health', async (req, res) => {
    const vaultInfo = await getVaultInfo();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        chumMint: CHUM_MINT,
        minHold: MIN_HOLD_REQUIREMENT,
        rpcUrl: RPC_URL.split('?')[0],
        playersTracked: playerRecords.size,
        totalSessions: gameSessions.size,
        authority: authority ? authority.publicKey.toString() : 'NOT LOADED',
        vault: vaultInfo
    });
});

// Vault info endpoint - shows where to send $CHUM for rewards
app.get('/api/vault-info', async (req, res) => {
    const vaultInfo = await getVaultInfo();
    res.json(vaultInfo);
});

// Check balance
app.get('/api/check-balance/:wallet', async (req, res) => {
    try {
        const walletAddress = req.params.wallet;
        if (!isValidSolanaAddress(walletAddress)) {
            return res.json({ wallet: walletAddress, balance: 0, required: MIN_HOLD_REQUIREMENT, eligible: false, error: 'Invalid wallet address' });
        }
        
        const chumBalance = await getComprehensiveTokenBalance(walletAddress, CHUM_MINT);
        const eligible = chumBalance >= MIN_HOLD_REQUIREMENT;
        const deficit = Math.max(0, MIN_HOLD_REQUIREMENT - chumBalance);
        const playerRecord = await loadPlayerRecord(walletAddress);
        
        res.json({
            wallet: walletAddress,
            balance: chumBalance,
            required: MIN_HOLD_REQUIREMENT,
            eligible,
            deficit,
            pendingRewards: playerRecord?.pendingRewards || 0,
            totalEarned: playerRecord?.totalEarned || 0,
            totalClaimed: playerRecord?.totalClaimed || 0,
            message: eligible 
                ? `✅ Eligible! You hold ${chumBalance.toLocaleString()} $CHUM`
                : `❌ Need ${deficit.toLocaleString()} more $CHUM`
        });
    } catch (error) {
        console.error('Balance check error:', error);
        res.status(500).json({ wallet: req.params.wallet, balance: 0, required: MIN_HOLD_REQUIREMENT, eligible: false, error: error.message });
    }
});

// Verify eligibility
app.post('/api/verify-eligibility', async (req, res) => {
    try {
        const { playerWallet } = req.body;
        if (!playerWallet) return res.status(400).json({ error: 'Player wallet required' });
        if (!isValidSolanaAddress(playerWallet)) return res.status(400).json({ eligible: false, error: 'Invalid wallet address' });
        
        const chumBalance = await getComprehensiveTokenBalance(playerWallet, CHUM_MINT);
        
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({
                eligible: false,
                balance: chumBalance,
                required: MIN_HOLD_REQUIREMENT,
                deficit: MIN_HOLD_REQUIREMENT - chumBalance,
                message: chumBalance === 0 ? 'No $CHUM tokens found.' : `Need ${(MIN_HOLD_REQUIREMENT - chumBalance).toLocaleString()} more $CHUM`
            });
        }
        
        const playerRecord = await getOrCreatePlayerRecord(playerWallet);
        playerRecord.balance = chumBalance;
        playerRecord.verifiedAt = Date.now();
        await savePlayerRecord(playerWallet, playerRecord);
        
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
        console.error('Verification error:', error);
        res.status(500).json({ eligible: false, error: error.message });
    }
});

// Record game results (tournament-only P2E model)
app.post('/api/record-game', async (req, res) => {
    try {
        const { playerWallet, points, finalScore } = req.body;
        if (!playerWallet || !points) return res.status(400).json({ error: 'Missing required fields' });

        const sessionId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const score = finalScore || points;

        // Always update player stats (practice or tournament)
        const playerRecord = await getOrCreatePlayerRecord(playerWallet);
        playerRecord.gamesPlayed += 1;
        playerRecord.lastGameAt = Date.now();

        // Check if tournament is active and player is registered
        let tournamentRecorded = false;
        let tournamentBestScore = 0;
        let tournamentGamesPlayed = 0;

        if (currentTournament && currentTournament.active && Date.now() <= currentTournament.endTime) {
            if (currentTournament.registrations[playerWallet]) {
                tournamentRecorded = await recordTournamentScore(playerWallet, score);
                tournamentBestScore = currentTournament.scores[playerWallet]?.bestScore || 0;
                tournamentGamesPlayed = currentTournament.scores[playerWallet]?.gamesPlayed || 0;
                console.log(`🏆 Tournament score: ${playerWallet.slice(0,4)}... = ${score} pts (best: ${tournamentBestScore})`);
            }
        }

        await savePlayerRecord(playerWallet, playerRecord);

        console.log(`🎮 ${playerWallet.slice(0,4)}... scored ${score} pts | Tournament: ${tournamentRecorded ? 'YES' : 'practice'}`);

        res.json({
            success: true,
            sessionId,
            points: score,
            gamesPlayed: playerRecord.gamesPlayed,
            // Tournament info
            tournamentActive: !!(currentTournament?.active && Date.now() <= currentTournament?.endTime),
            tournamentRegistered: !!(currentTournament?.registrations?.[playerWallet]),
            tournamentScoreRecorded: tournamentRecorded,
            tournamentBestScore,
            tournamentGamesPlayed,
            // Existing rewards (from past tournaments)
            pendingRewards: parseFloat((playerRecord.pendingRewards || 0).toFixed(4)),
            totalEarned: parseFloat((playerRecord.totalEarned || 0).toFixed(4)),
            totalClaimed: parseFloat((playerRecord.totalClaimed || 0).toFixed(4)),
            message: tournamentRecorded
                ? `🏆 Tournament score: ${score} pts! Best: ${tournamentBestScore}`
                : `🎮 Practice score: ${score} pts`
        });
    } catch (error) {
        console.error('Record game error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== CLAIM REWARDS - Builds real SPL transaction for player to sign =====
app.post('/api/claim-rewards', async (req, res) => {
    try {
        const { playerWallet, claimAmount } = req.body;
        if (!playerWallet) return res.status(400).json({ error: 'Player wallet required' });

        // Check authority is loaded
        if (!authority) {
            return res.status(500).json({
                success: false,
                error: 'AUTHORITY_NOT_CONFIGURED',
                message: 'Server reward authority not configured. Contact admin.'
            });
        }

        // Check player has pending rewards
        const playerRecord = await loadPlayerRecord(playerWallet);
        if (!playerRecord || playerRecord.pendingRewards <= 0) {
            return res.json({ success: false, message: 'No pending rewards to claim', pendingRewards: 0 });
        }

        // Verify player still holds enough $CHUM
        const chumBalance = await getComprehensiveTokenBalance(playerWallet, CHUM_MINT);
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({
                success: false, error: 'INSUFFICIENT_BALANCE',
                balance: chumBalance, required: MIN_HOLD_REQUIREMENT,
                message: `Need at least ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM to claim rewards`
            });
        }

        // Determine claim amount
        const amountToClaim = (claimAmount && claimAmount > 0 && claimAmount <= playerRecord.pendingRewards)
            ? claimAmount
            : playerRecord.pendingRewards;

        const mint = new PublicKey(CHUM_MINT);
        const playerPubkey = new PublicKey(playerWallet);

        // Find authority's actual token account (handles pump.fun non-standard ATAs)
        const vaultAccount = await findTokenAccount(authority.publicKey.toString(), CHUM_MINT);
        
        if (!vaultAccount) {
            return res.status(500).json({
                success: false,
                error: 'VAULT_NOT_FUNDED',
                message: 'Reward vault has no $CHUM tokens. Admin needs to fund it.',
                authorityWallet: authority.publicKey.toString()
            });
        }

        const decimals = vaultAccount.decimals;
        const rawAmount = BigInt(Math.floor(amountToClaim * Math.pow(10, decimals)));

        console.log(`💰 Building claim TX: ${amountToClaim.toFixed(4)} $CHUM (${rawAmount} raw, ${decimals} decimals)`);
        console.log(`   From: ${authority.publicKey.toString()} (account: ${vaultAccount.address.toString()})`);
        console.log(`   To: ${playerWallet}`);
        console.log(`   Vault balance: ${vaultAccount.balance} $CHUM (raw: ${vaultAccount.rawBalance})`);
        console.log(`   Token program: ${vaultAccount.programId.toString()}`);

        if (vaultAccount.rawBalance < rawAmount) {
            return res.status(500).json({
                success: false,
                error: 'VAULT_INSUFFICIENT',
                message: `Vault only has ${vaultAccount.balance.toFixed(4)} $CHUM, need ${amountToClaim.toFixed(4)}`,
                vaultBalance: vaultAccount.balance
            });
        }

        // Get or create player's ATA (destination) - use same token program as source
        const playerAta = await getAssociatedTokenAddress(
            mint, 
            playerPubkey, 
            false,
            vaultAccount.programId  // Use same token program as the vault
        );

        // Build transaction
        const transaction = new Transaction();

        // Check if player ATA exists, if not add create instruction
        try {
            await getAccount(connection, playerAta, 'confirmed', vaultAccount.programId);
        } catch (e) {
            // ATA doesn't exist, need to create it
            console.log(`   Creating ATA for player: ${playerAta.toString()}`);
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    playerPubkey,          // payer (player pays for their own ATA)
                    playerAta,             // ata address
                    playerPubkey,          // owner
                    mint,                  // mint
                    vaultAccount.programId // token program
                )
            );
        }

        // Add the SPL token transfer instruction
        transaction.add(
            createTransferInstruction(
                vaultAccount.address,    // source (authority's actual token account)
                playerAta,               // destination (player's token account)
                authority.publicKey,     // owner of source (authority signs)
                rawAmount,               // amount in raw units
                [],                      // no multisig
                vaultAccount.programId   // use same token program as source
            )
        );

        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.feePayer = playerPubkey; // Player pays gas

        // DO NOT sign here — Phantom must sign FIRST, then authority co-signs after
        // This is the signing order Phantom's Lighthouse security requires

        // Serialize the transaction unsigned
        const serializedTx = transaction.serialize({
            requireAllSignatures: false,
            verifySignatures: false
        }).toString('base64');

        const claimId = `claim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // DON'T update records yet - wait for /api/confirm-claim after tx confirms
        console.log(`✅ Claim TX built (unsigned): ${claimId} | ${amountToClaim.toFixed(4)} $CHUM -> ${playerWallet.slice(0,8)}...`);

        res.json({
            success: true,
            claimId,
            claimAmount: parseFloat(amountToClaim.toFixed(4)),
            transaction: serializedTx,
            blockhash,
            lastValidBlockHeight,
            message: `Sign the transaction to claim ${amountToClaim.toFixed(4)} $CHUM`
        });
    } catch (error) {
        console.error('❌ Claim error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== CO-SIGN CLAIM - Player signed first, now authority adds signature =====
app.post('/api/cosign-claim', async (req, res) => {
    try {
        const { signedTransaction } = req.body;
        if (!signedTransaction) {
            return res.status(400).json({ error: 'Missing signedTransaction' });
        }

        if (!authority) {
            return res.status(500).json({ error: 'Authority not configured' });
        }

        // Deserialize the player-signed transaction
        const txBuffer = Buffer.from(signedTransaction, 'base64');
        const transaction = Transaction.from(txBuffer);

        // Authority co-signs AFTER Phantom (correct order per Phantom Lighthouse)
        transaction.partialSign(authority);

        // Serialize the fully-signed transaction
        const fullySigned = transaction.serialize().toString('base64');

        console.log(`✅ Authority co-signed claim transaction`);

        res.json({
            success: true,
            transaction: fullySigned
        });
    } catch (error) {
        console.error('❌ Co-sign error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== CONFIRM CLAIM - Called after player signs & submits TX =====
app.post('/api/confirm-claim', async (req, res) => {
    try {
        const { playerWallet, claimId, signature, claimAmount } = req.body;
        if (!playerWallet || !signature) {
            return res.status(400).json({ error: 'Missing playerWallet or signature' });
        }

        console.log(`🔍 Confirming claim: ${claimId} | sig: ${signature.slice(0, 20)}...`);

        // Verify the transaction actually confirmed on-chain
        let confirmed = false;
        try {
            const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
            if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
                confirmed = true;
            } else {
                // Wait a bit and retry
                await new Promise(resolve => setTimeout(resolve, 3000));
                const status2 = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
                if (status2?.value?.confirmationStatus === 'confirmed' || status2?.value?.confirmationStatus === 'finalized') {
                    confirmed = true;
                }
            }
        } catch (e) {
            console.log(`⚠️ Signature check failed: ${e.message}, will verify via transaction details`);
        }

        // Also try getTransaction as a fallback verification
        if (!confirmed) {
            try {
                await new Promise(resolve => setTimeout(resolve, 2000));
                const txInfo = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
                if (txInfo && !txInfo.meta?.err) {
                    confirmed = true;
                }
            } catch (e) {
                console.log(`⚠️ getTransaction fallback failed: ${e.message}`);
            }
        }

        if (!confirmed) {
            return res.json({
                success: false,
                error: 'TX_NOT_CONFIRMED',
                signature,
                message: 'Transaction not confirmed yet. It may still be processing — check your wallet.'
            });
        }

        // Transaction confirmed! Now update player records
        const playerRecord = await loadPlayerRecord(playerWallet);
        if (playerRecord) {
            const amount = claimAmount || playerRecord.pendingRewards;
            playerRecord.totalClaimed += amount;
            playerRecord.pendingRewards = Math.max(0, playerRecord.pendingRewards - amount);
            playerRecord.lastClaimAt = Date.now();

            // Mark earn history entries as claimed
            let remaining = amount;
            for (let entry of playerRecord.earnHistory) {
                if (!entry.claimed && remaining > 0) {
                    if (entry.chumEarned <= remaining) {
                        entry.claimed = true;
                        entry.claimedAt = Date.now();
                        entry.claimId = claimId;
                        entry.signature = signature;
                        remaining -= entry.chumEarned;
                    } else {
                        break;
                    }
                }
            }

            await savePlayerRecord(playerWallet, playerRecord);
        }

        console.log(`✅ Claim confirmed! ${claimAmount?.toFixed(4)} $CHUM -> ${playerWallet.slice(0,8)}... | sig: ${signature.slice(0,20)}...`);

        res.json({
            success: true,
            claimId,
            signature,
            claimAmount: parseFloat((claimAmount || 0).toFixed(4)),
            remainingPending: parseFloat((playerRecord?.pendingRewards || 0).toFixed(4)),
            totalClaimed: parseFloat((playerRecord?.totalClaimed || 0).toFixed(4)),
            totalEarned: parseFloat((playerRecord?.totalEarned || 0).toFixed(4)),
            explorerUrl: `https://solscan.io/tx/${signature}`,
            message: `🎉 Successfully claimed! View on Solscan: https://solscan.io/tx/${signature}`
        });
    } catch (error) {
        console.error('❌ Confirm claim error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Player stats
app.get('/api/player/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;
        const record = await loadPlayerRecord(wallet);
        if (!record) return res.status(404).json({ error: 'Player not found' });
        const recentGames = record.earnHistory.slice(-10).reverse().map(entry => ({
            sessionId: entry.sessionId, points: entry.points,
            chumEarned: parseFloat(entry.chumEarned.toFixed(4)),
            timestamp: entry.timestamp, claimed: entry.claimed,
            signature: entry.signature || null
        }));
        res.json({
            wallet: record.wallet, balance: record.balance,
            totalEarned: parseFloat(record.totalEarned.toFixed(4)),
            totalClaimed: parseFloat(record.totalClaimed.toFixed(4)),
            pendingRewards: parseFloat(record.pendingRewards.toFixed(4)),
            gamesPlayed: record.gamesPlayed, lastGameAt: record.lastGameAt,
            lastClaimAt: record.lastClaimAt, recentGames
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Leaderboard
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
                gamesPlayed: p.gamesPlayed
            }));
        res.json({ leaderboard, totalPlayers: playerRecords.size });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== TOURNAMENT SYSTEM =====

// Tournament state (cached in memory, persisted to Firebase)
let currentTournament = null;

// Default prize tiers (769,230 $CHUM per week from 80M/104 weeks)
const DEFAULT_PRIZE_TIERS = [
    { rank: 1, amount: 150000 },
    { rank: 2, amount: 80000 },
    { rank: 3, amount: 50000 },
    { rank: 4, amount: 30000 },
    { rank: 5, amount: 20000 },
    { rank: 6, amount: 10000 },
    { rank: 7, amount: 10000 },
    { rank: 8, amount: 10000 },
    { rank: 9, amount: 10000 },
    { rank: 10, amount: 10000 },
    // 11-25: 4,000 each
    // 26-50: 2,500 each
    // 51-100: 1,500 each
    // Top 50% of rest: 500 each
    // All participants: split remainder
];

// Load tournament state from Firebase on startup
async function loadTournamentState() {
    const data = await firebaseLoad('tournaments/current');
    if (data && data.active) {
        currentTournament = data;
        // Ensure scores object exists
        if (!currentTournament.scores) currentTournament.scores = {};
        if (!currentTournament.registrations) currentTournament.registrations = {};
        console.log(`🏆 Active tournament loaded: ${currentTournament.name} (${Object.keys(currentTournament.registrations).length} players)`);
    } else {
        console.log('🎮 No active tournament');
    }
}
loadTournamentState();

// Admin auth middleware
function adminAuth(req, res, next) {
    const key = req.query.key || req.body?.key || req.headers['x-admin-key'];
    if (key !== ADMIN_KEY) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }
    next();
}

// ===== ADMIN ENDPOINTS =====

// Start tournament
app.post('/admin/tournament/start', adminAuth, async (req, res) => {
    try {
        if (currentTournament && currentTournament.active) {
            return res.status(400).json({ error: 'Tournament already active', tournament: currentTournament.name });
        }

        const { name, duration, prizePool } = req.body;
        const durationHours = duration || 24;
        const pool = prizePool || 769230;

        const tournamentId = `tournament_${Date.now()}`;
        const startTime = Date.now();
        const endTime = startTime + (durationHours * 60 * 60 * 1000);

        currentTournament = {
            id: tournamentId,
            name: name || `BullShark Weekly Tournament`,
            active: true,
            startTime,
            endTime,
            durationHours,
            prizePool: pool,
            registrations: {},
            scores: {},
            createdAt: startTime
        };

        await firebaseSave('tournaments/current', currentTournament);
        console.log(`🏆 Tournament started: ${currentTournament.name} | ${durationHours}hrs | ${pool.toLocaleString()} $CHUM pool`);

        res.json({
            success: true,
            tournament: {
                id: tournamentId,
                name: currentTournament.name,
                startTime: new Date(startTime).toISOString(),
                endTime: new Date(endTime).toISOString(),
                durationHours,
                prizePool: pool
            }
        });
    } catch (error) {
        console.error('Tournament start error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stop tournament + calculate results
app.post('/admin/tournament/stop', adminAuth, async (req, res) => {
    try {
        if (!currentTournament || !currentTournament.active) {
            return res.status(400).json({ error: 'No active tournament' });
        }

        // Calculate final rankings
        const results = calculateTournamentResults(currentTournament);

        // Save to history
        const historyEntry = {
            ...currentTournament,
            active: false,
            endedAt: Date.now(),
            results
        };
        await firebaseSave(`tournaments/history/${currentTournament.id}`, historyEntry);

        // Award prizes to player records (pending rewards)
        for (const winner of results.winners) {
            if (winner.prize > 0) {
                const playerRecord = await getOrCreatePlayerRecord(winner.wallet);
                playerRecord.totalEarned += winner.prize;
                playerRecord.pendingRewards += winner.prize;
                playerRecord.earnHistory.push({
                    sessionId: `tournament_${currentTournament.id}`,
                    points: winner.bestScore,
                    chumEarned: winner.prize,
                    timestamp: Date.now(),
                    claimed: false,
                    tournamentPrize: true,
                    tournamentName: currentTournament.name,
                    rank: winner.rank
                });
                await savePlayerRecord(winner.wallet, playerRecord);
            }
        }

        console.log(`🏆 Tournament ended: ${currentTournament.name} | ${results.winners.length} winners`);

        // Clear current tournament
        currentTournament = null;
        await firebaseSave('tournaments/current', { active: false });

        res.json({
            success: true,
            message: 'Tournament ended and prizes awarded to pending rewards',
            results
        });
    } catch (error) {
        console.error('Tournament stop error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin tournament status
app.get('/admin/tournament/status', adminAuth, async (req, res) => {
    if (!currentTournament || !currentTournament.active) {
        return res.json({ active: false, message: 'No active tournament' });
    }

    const timeRemaining = Math.max(0, currentTournament.endTime - Date.now());
    const registeredCount = Object.keys(currentTournament.registrations).length;
    const scoresCount = Object.keys(currentTournament.scores).length;

    res.json({
        active: true,
        tournament: {
            id: currentTournament.id,
            name: currentTournament.name,
            startTime: new Date(currentTournament.startTime).toISOString(),
            endTime: new Date(currentTournament.endTime).toISOString(),
            timeRemainingMs: timeRemaining,
            timeRemainingHuman: formatTime(timeRemaining),
            prizePool: currentTournament.prizePool,
            registeredPlayers: registeredCount,
            playersWithScores: scoresCount
        },
        topScores: getTopScores(currentTournament, 20)
    });
});

// Admin: view tournament history
app.get('/admin/tournament/history', adminAuth, async (req, res) => {
    try {
        const history = await firebaseLoad('tournaments/history');
        if (!history) return res.json({ tournaments: [] });
        
        const tournaments = Object.values(history)
            .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
            .slice(0, 20)
            .map(t => ({
                id: t.id,
                name: t.name,
                startTime: new Date(t.startTime).toISOString(),
                endedAt: t.endedAt ? new Date(t.endedAt).toISOString() : null,
                prizePool: t.prizePool,
                totalPlayers: Object.keys(t.registrations || {}).length,
                topWinners: t.results?.winners?.slice(0, 5) || []
            }));
        
        res.json({ tournaments });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== PUBLIC TOURNAMENT ENDPOINTS =====

// Public tournament status
app.get('/api/tournament/status', (req, res) => {
    if (!currentTournament || !currentTournament.active) {
        return res.json({ active: false });
    }

    const timeRemaining = Math.max(0, currentTournament.endTime - Date.now());
    const isExpired = timeRemaining <= 0;

    res.json({
        active: !isExpired,
        id: currentTournament.id,
        name: currentTournament.name,
        startTime: currentTournament.startTime,
        endTime: currentTournament.endTime,
        timeRemainingMs: timeRemaining,
        timeRemainingHuman: formatTime(timeRemaining),
        prizePool: currentTournament.prizePool,
        registeredPlayers: Object.keys(currentTournament.registrations).length,
        playersWithScores: Object.keys(currentTournament.scores).length
    });
});

// Register for tournament
app.post('/api/tournament/register', async (req, res) => {
    try {
        const { playerWallet } = req.body;
        if (!playerWallet) return res.status(400).json({ error: 'Wallet required' });

        if (!currentTournament || !currentTournament.active) {
            return res.json({ success: false, error: 'NO_ACTIVE_TOURNAMENT', message: 'No tournament is currently active' });
        }

        // Check if tournament time expired
        if (Date.now() > currentTournament.endTime) {
            return res.json({ success: false, error: 'TOURNAMENT_ENDED', message: 'Tournament has ended' });
        }

        // Check if already registered
        if (currentTournament.registrations[playerWallet]) {
            return res.json({ success: true, message: 'Already registered', alreadyRegistered: true });
        }

        // Verify holds minimum $CHUM
        const chumBalance = await getComprehensiveTokenBalance(playerWallet, CHUM_MINT);
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({
                success: false,
                error: 'INSUFFICIENT_BALANCE',
                balance: chumBalance,
                required: MIN_HOLD_REQUIREMENT,
                message: `Need ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM to enter tournament`
            });
        }

        // Register
        currentTournament.registrations[playerWallet] = {
            registeredAt: Date.now(),
            balance: chumBalance
        };

        await firebaseSave('tournaments/current', currentTournament);
        console.log(`🏆 ${playerWallet.slice(0, 8)}... registered for tournament (${Object.keys(currentTournament.registrations).length} total)`);

        res.json({
            success: true,
            message: `Registered for ${currentTournament.name}!`,
            tournamentName: currentTournament.name,
            endTime: currentTournament.endTime,
            prizePool: currentTournament.prizePool
        });
    } catch (error) {
        console.error('Tournament register error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Tournament leaderboard (public)
app.get('/api/tournament/leaderboard', (req, res) => {
    if (!currentTournament || !currentTournament.active) {
        return res.json({ active: false, leaderboard: [] });
    }

    const leaderboard = getTopScores(currentTournament, parseInt(req.query.limit) || 50);
    const timeRemaining = Math.max(0, currentTournament.endTime - Date.now());

    res.json({
        active: true,
        tournamentName: currentTournament.name,
        timeRemainingMs: timeRemaining,
        timeRemainingHuman: formatTime(timeRemaining),
        prizePool: currentTournament.prizePool,
        totalPlayers: Object.keys(currentTournament.registrations).length,
        leaderboard
    });
});

// Check if player is registered for current tournament
app.get('/api/tournament/check/:wallet', (req, res) => {
    const wallet = req.params.wallet;
    
    if (!currentTournament || !currentTournament.active) {
        return res.json({ active: false, registered: false });
    }

    const isRegistered = !!currentTournament.registrations[wallet];
    const playerScore = currentTournament.scores[wallet];
    const timeRemaining = Math.max(0, currentTournament.endTime - Date.now());

    res.json({
        active: true,
        registered: isRegistered,
        tournamentName: currentTournament.name,
        timeRemainingMs: timeRemaining,
        timeRemainingHuman: formatTime(timeRemaining),
        prizePool: currentTournament.prizePool,
        bestScore: playerScore?.bestScore || 0,
        gamesPlayed: playerScore?.gamesPlayed || 0
    });
});

// Past tournament results (public)
app.get('/api/tournament/results/:tournamentId', async (req, res) => {
    try {
        const data = await firebaseLoad(`tournaments/history/${req.params.tournamentId}`);
        if (!data) return res.status(404).json({ error: 'Tournament not found' });

        res.json({
            id: data.id,
            name: data.name,
            startTime: data.startTime,
            endedAt: data.endedAt,
            prizePool: data.prizePool,
            totalPlayers: Object.keys(data.registrations || {}).length,
            results: data.results
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Past tournaments list (public)
app.get('/api/tournament/history', async (req, res) => {
    try {
        const history = await firebaseLoad('tournaments/history');
        if (!history) return res.json({ tournaments: [] });
        
        const tournaments = Object.values(history)
            .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
            .slice(0, 20)
            .map(t => ({
                id: t.id,
                name: t.name,
                startTime: t.startTime,
                endedAt: t.endedAt,
                prizePool: t.prizePool,
                totalPlayers: Object.keys(t.registrations || {}).length,
                topWinners: (t.results?.winners || []).slice(0, 3).map(w => ({
                    rank: w.rank,
                    wallet: `${w.wallet.slice(0, 4)}...${w.wallet.slice(-4)}`,
                    bestScore: w.bestScore,
                    prize: w.prize
                }))
            }));
        
        res.json({ tournaments });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== TOURNAMENT HELPER FUNCTIONS =====

function formatTime(ms) {
    if (ms <= 0) return 'Ended';
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function getTopScores(tournament, limit) {
    if (!tournament.scores) return [];
    return Object.entries(tournament.scores)
        .map(([wallet, data]) => ({
            wallet: `${wallet.slice(0, 4)}...${wallet.slice(-4)}`,
            fullWallet: wallet,
            bestScore: data.bestScore,
            gamesPlayed: data.gamesPlayed,
            lastGameAt: data.lastGameAt
        }))
        .sort((a, b) => b.bestScore - a.bestScore)
        .slice(0, limit)
        .map((entry, index) => ({ rank: index + 1, ...entry }));
}

function calculateTournamentResults(tournament) {
    const ranked = getTopScores(tournament, 99999);
    const totalPlayers = ranked.length;
    const pool = tournament.prizePool;
    const winners = [];

    let distributed = 0;

    for (let i = 0; i < ranked.length; i++) {
        const rank = i + 1;
        let prize = 0;

        // Top 10: fixed prizes
        if (rank === 1) prize = Math.floor(pool * 0.195);
        else if (rank === 2) prize = Math.floor(pool * 0.104);
        else if (rank === 3) prize = Math.floor(pool * 0.065);
        else if (rank === 4) prize = Math.floor(pool * 0.039);
        else if (rank === 5) prize = Math.floor(pool * 0.026);
        else if (rank <= 10) prize = Math.floor(pool * 0.013);
        // 11-25
        else if (rank <= 25) prize = Math.floor(pool * 0.0052);
        // 26-50
        else if (rank <= 50) prize = Math.floor(pool * 0.00325);
        // 51-100
        else if (rank <= 100) prize = Math.floor(pool * 0.00195);
        // Top 50% of remaining
        else if (rank <= Math.ceil(totalPlayers * 0.75)) prize = Math.floor(pool * 0.00065);
        // Everyone else gets participation
        else prize = Math.max(1, Math.floor(pool * 0.0001));

        distributed += prize;
        winners.push({
            rank,
            wallet: ranked[i].fullWallet,
            walletShort: ranked[i].wallet,
            bestScore: ranked[i].bestScore,
            gamesPlayed: ranked[i].gamesPlayed,
            prize: parseFloat(prize.toFixed(4))
        });
    }

    return {
        totalPlayers,
        totalDistributed: distributed,
        prizePool: pool,
        winners
    };
}

// Record tournament score (called from record-game when tournament is active)
async function recordTournamentScore(wallet, points) {
    if (!currentTournament || !currentTournament.active) return false;
    if (!currentTournament.registrations[wallet]) return false;
    if (Date.now() > currentTournament.endTime) return false;

    if (!currentTournament.scores[wallet]) {
        currentTournament.scores[wallet] = {
            bestScore: 0,
            gamesPlayed: 0,
            allScores: [],
            lastGameAt: null
        };
    }

    const playerTourney = currentTournament.scores[wallet];
    playerTourney.gamesPlayed += 1;
    playerTourney.lastGameAt = Date.now();
    playerTourney.allScores.push({ points, timestamp: Date.now() });
    
    // Keep only best score (single best score format)
    if (points > playerTourney.bestScore) {
        playerTourney.bestScore = points;
    }

    // Keep allScores manageable (last 100 games)
    if (playerTourney.allScores.length > 100) {
        playerTourney.allScores = playerTourney.allScores.slice(-100);
    }

    // Save to Firebase (async)
    firebaseSave('tournaments/current', currentTournament);
    return true;
}

const PORT = process.env.PORT || 3000;

if (process.env.VERCEL !== '1') {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🦈 BullShark P2E API running on port ${PORT}`);
        console.log(`📡 RPC: ${RPC_URL.split('?')[0]}`);
        console.log(`💎 $CHUM Mint: ${CHUM_MINT}`);
        console.log(`🎮 Min Hold: ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM`);
        console.log(`🎯 Conversion: ${POINTS_PER_CHUM.toLocaleString()} points = 1 $CHUM`);
        console.log(`🔑 Authority: ${authority ? authority.publicKey.toString() : '❌ NOT LOADED'}`);
        console.log(`🏆 Tournament mode: ${currentTournament?.active ? 'ACTIVE' : 'inactive'}`);
        console.log(`🔐 Admin key: ${ADMIN_KEY ? 'SET' : '❌ NOT SET'}`);
        if (authority) {
            console.log(`\n💰 To fund the reward vault, send $CHUM to the authority wallet:`);
            console.log(`   ${authority.publicKey.toString()}`);
            console.log(`   Then check /api/vault-info to verify\n`);
        }
    });
}

module.exports = app;

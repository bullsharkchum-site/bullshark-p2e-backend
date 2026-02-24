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
const POINTS_PER_CHUM = 3000;

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

// In-memory storage
const gameSessions = new Map();
const playerRecords = new Map();

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

// ===== VAULT INFO HELPER =====

async function getVaultInfo() {
  if (!authority) return { funded: false, error: 'Authority keypair not loaded' };
  
  try {
    const mint = new PublicKey(CHUM_MINT);
    const authorityAta = await getAssociatedTokenAddress(mint, authority.publicKey);
    
    let vaultBalance = 0;
    try {
      const accountInfo = await getAccount(connection, authorityAta);
      // Get mint info for decimals
      const mintInfo = await getMint(connection, mint);
      vaultBalance = Number(accountInfo.amount) / Math.pow(10, mintInfo.decimals);
    } catch (e) {
      // ATA doesn't exist yet
      vaultBalance = 0;
    }
    
    return {
      funded: vaultBalance > 0,
      vaultBalance,
      authorityWallet: authority.publicKey.toString(),
      authorityAta: authorityAta.toString(),
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
        const playerRecord = playerRecords.get(walletAddress);
        
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
        
        const playerRecord = getOrCreatePlayerRecord(playerWallet);
        playerRecord.balance = chumBalance;
        playerRecord.verifiedAt = Date.now();
        
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

// Record game results
app.post('/api/record-game', async (req, res) => {
    try {
        const { playerWallet, points, finalScore } = req.body;
        if (!playerWallet || !points) return res.status(400).json({ error: 'Missing required fields' });
        if (points < POINTS_PER_CHUM) {
            return res.json({ success: false, message: `Need at least ${POINTS_PER_CHUM.toLocaleString()} points to earn $CHUM` });
        }

        const chumBalance = await getComprehensiveTokenBalance(playerWallet, CHUM_MINT);
        if (chumBalance < MIN_HOLD_REQUIREMENT) {
            return res.json({ success: false, error: 'INSUFFICIENT_BALANCE', balance: chumBalance, required: MIN_HOLD_REQUIREMENT });
        }

        const chumEarned = points / POINTS_PER_CHUM;
        const sessionId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        gameSessions.set(sessionId, {
            sessionId, player: playerWallet, points, finalScore: finalScore || points,
            chumEarned, timestamp: Date.now(), claimed: false
        });

        const playerRecord = getOrCreatePlayerRecord(playerWallet);
        playerRecord.totalEarned += chumEarned;
        playerRecord.pendingRewards += chumEarned;
        playerRecord.gamesPlayed += 1;
        playerRecord.lastGameAt = Date.now();
        playerRecord.balance = chumBalance;
        playerRecord.earnHistory.push({ sessionId, points, chumEarned, timestamp: Date.now(), claimed: false });

        console.log(`🎮 ${playerWallet.slice(0,4)}... earned ${chumEarned.toFixed(4)} $CHUM (pending: ${playerRecord.pendingRewards.toFixed(4)})`);
        
        res.json({
            success: true, sessionId, points,
            chumEarned: parseFloat(chumEarned.toFixed(4)),
            pendingRewards: parseFloat(playerRecord.pendingRewards.toFixed(4)),
            totalEarned: parseFloat(playerRecord.totalEarned.toFixed(4)),
            totalClaimed: parseFloat(playerRecord.totalClaimed.toFixed(4)),
            gamesPlayed: playerRecord.gamesPlayed,
            message: `🦈 You earned ${chumEarned.toFixed(4)} $CHUM! Total pending: ${playerRecord.pendingRewards.toFixed(4)}`
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
        const playerRecord = playerRecords.get(playerWallet);
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

        // Get mint info for decimals
        const mintInfo = await getMint(connection, mint);
        const decimals = mintInfo.decimals;
        const rawAmount = BigInt(Math.floor(amountToClaim * Math.pow(10, decimals)));

        console.log(`💰 Building claim TX: ${amountToClaim.toFixed(4)} $CHUM (${rawAmount} raw, ${decimals} decimals)`);
        console.log(`   From: ${authority.publicKey.toString()}`);
        console.log(`   To: ${playerWallet}`);

        // Get authority's ATA (source vault)
        const authorityAta = await getAssociatedTokenAddress(mint, authority.publicKey);
        
        // Check authority vault has enough tokens
        let vaultBalance;
        try {
            const vaultAccount = await getAccount(connection, authorityAta);
            vaultBalance = vaultAccount.amount;
        } catch (e) {
            return res.status(500).json({
                success: false,
                error: 'VAULT_NOT_FUNDED',
                message: 'Reward vault has no tokens. Admin needs to fund it.',
                authorityWallet: authority.publicKey.toString(),
                authorityAta: authorityAta.toString()
            });
        }

        if (vaultBalance < rawAmount) {
            const vaultUi = Number(vaultBalance) / Math.pow(10, decimals);
            return res.status(500).json({
                success: false,
                error: 'VAULT_INSUFFICIENT',
                message: `Vault only has ${vaultUi.toFixed(4)} $CHUM, need ${amountToClaim.toFixed(4)}`,
                vaultBalance: vaultUi
            });
        }

        // Get or create player's ATA (destination)
        const playerAta = await getAssociatedTokenAddress(mint, playerPubkey);

        // Build transaction
        const transaction = new Transaction();

        // Check if player ATA exists, if not add create instruction
        let playerAtaExists = false;
        try {
            await getAccount(connection, playerAta);
            playerAtaExists = true;
        } catch (e) {
            // ATA doesn't exist, need to create it
            console.log(`   Creating ATA for player: ${playerAta.toString()}`);
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    playerPubkey,    // payer (player pays for their own ATA)
                    playerAta,       // ata address
                    playerPubkey,    // owner
                    mint             // mint
                )
            );
        }

        // Add the SPL token transfer instruction
        // Authority transfers from their ATA to player's ATA
        transaction.add(
            createTransferInstruction(
                authorityAta,          // source (authority's token account)
                playerAta,             // destination (player's token account)
                authority.publicKey,   // owner of source (authority signs)
                rawAmount,             // amount in raw units
                [],                    // no multisig
                SPL_TOKEN_PROGRAM_ID   // token program
            )
        );

        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.feePayer = playerPubkey; // Player pays gas

        // Authority partially signs the transaction
        transaction.partialSign(authority);

        // Serialize the transaction (with requireAllSignatures: false since player hasn't signed yet)
        const serializedTx = transaction.serialize({
            requireAllSignatures: false,
            verifySignatures: false
        }).toString('base64');

        const claimId = `claim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // DON'T update records yet - wait for /api/confirm-claim after tx confirms
        console.log(`✅ Claim TX built: ${claimId} | ${amountToClaim.toFixed(4)} $CHUM -> ${playerWallet.slice(0,8)}...`);

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
        const playerRecord = playerRecords.get(playerWallet);
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
        const record = playerRecords.get(wallet);
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

const PORT = process.env.PORT || 3000;

if (process.env.VERCEL !== '1') {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🦈 BullShark P2E API running on port ${PORT}`);
        console.log(`📡 RPC: ${RPC_URL.split('?')[0]}`);
        console.log(`💎 $CHUM Mint: ${CHUM_MINT}`);
        console.log(`🎮 Min Hold: ${MIN_HOLD_REQUIREMENT.toLocaleString()} $CHUM`);
        console.log(`🎯 Conversion: ${POINTS_PER_CHUM.toLocaleString()} points = 1 $CHUM`);
        console.log(`🔑 Authority: ${authority ? authority.publicKey.toString() : '❌ NOT LOADED'}`);
        if (authority) {
            console.log(`\n💰 To fund the reward vault, send $CHUM to the authority wallet:`);
            console.log(`   ${authority.publicKey.toString()}`);
            console.log(`   Then check /api/vault-info to verify\n`);
        }
    });
}

module.exports = app;

# BullShark P2E Backend

Backend API for BullShark Feeding Frenzy Play-to-Earn rewards system.

## Features

- ✅ 25,000 $CHUM minimum hold requirement
- ✅ 3,000 points = 1 $CHUM conversion
- ✅ Real-time balance verification
- ✅ Player stats tracking
- ✅ Session management

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file with your configuration

3. Run:
```bash
npm start
```

## Endpoints

- `GET /health` - Health check
- `GET /api/check-balance/:wallet` - Check player balance
- `POST /api/verify-eligibility` - Verify player for P2E
- `POST /api/claim-rewards` - Claim game rewards
- `GET /api/player/:wallet` - Get player stats

## Deploy to Render

1. Push to GitHub
2. Connect repo to Render
3. Set environment variables
4. Deploy!
```

---

### **FILE 5: `.gitignore`**
```
node_modules/
.env
*.log
.DS_Store
```

---

## 🚀 **DEPLOYMENT TO RENDER**

1. **Create the GitHub repo** with all files above
2. **Go to Render.com**
3. **New Web Service**
4. **Connect your `bullshark-p2e-backend` repo**
5. **Settings:**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment Variables:
```
     RPC_URL=https://api.mainnet-beta.solana.com
     CHUM_MINT=<your_chum_mint>
     AUTHORITY_KEYPAIR=[your,keypair,array]
     ADMIN_KEY=<random_secure_key>

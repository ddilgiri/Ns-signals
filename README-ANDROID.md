# NSE F&O Signal Engine — Android Mobile App

## ✅ How to Run on Your Android Phone

This is a PWA (Progressive Web App). It installs on Android like a real app —
full screen, home screen icon, push notifications. No Play Store needed.

---

## STEP 1 — Start server.js on your PC/Laptop

Your phone connects to your PC via WiFi to get live Angel One data.

### Windows:
Double-click `START-WINDOWS.bat`
(or open CMD → `node server.js`)

### Mac/Linux:
```
chmod +x start-mac-linux.sh
./start-mac-linux.sh
```

Server starts at http://localhost:3001

---

## STEP 2 — Find your PC's IP address

Your Android phone needs your PC's IP (both must be on same WiFi).

### Windows:
Open CMD → type: `ipconfig`
Look for: `IPv4 Address . . . . : 192.168.x.x`

### Mac:
Open Terminal → type: `ifconfig | grep "inet "`
Look for: `inet 192.168.x.x`

### Linux:
`hostname -I`

**Example:** Your PC IP is `192.168.1.105`
→ Server URL = `http://192.168.1.105:3001`

---

## STEP 3 — Open on Android Chrome

1. Open **Google Chrome** on your Android phone
2. Go to: `http://YOUR_PC_IP:3001/index.html`
   Example: `http://192.168.1.105:3001/index.html`
3. The app opens!

---

## STEP 4 — Install as Home Screen App

Chrome will show an **"Install App"** banner at the bottom automatically.

Or manually:
1. Tap Chrome's **⋮ menu** (top right)
2. Tap **"Add to Home Screen"** or **"Install App"**
3. Tap **"Install"**
4. App icon appears on your home screen!
5. Open it — runs full screen like a native app ✅

---

## STEP 5 — Connect Angel One in the App

1. Open the app → tap **Setup** tab (bottom nav)
2. Enter your **Server URL**: `http://192.168.1.105:3001`
   (replace with your actual PC IP)
3. Tap **Test** to verify connection
4. Enter your **Angel One credentials**:
   - Client ID (e.g. A123456)
   - SmartAPI Key (from smartapi.angelbroking.com)
   - Password / PIN
   - TOTP Secret (optional, for auto 2FA)
5. Tap **Connect Angel One**
6. Go to **Signals** tab → tap **▶ SCAN**

---

## Using the App

### Bottom Navigation:
- ⚡ **Signals** — Live F&O signal feed with real premiums
- 📊 **Analysis** — PCR ratios, signal parameters
- ⚙️ **Scanner** — Configure capital, target %, stop loss
- 📋 **Stocks** — Select which F&O stocks to scan
- 🔌 **Setup** — Angel One API connection

### Signal Cards:
- **LIVE badge** = Premium fetched from Angel One NFO (real market price)
- **EST badge** = Estimated premium (fallback when option chain unavailable)
- Tap any signal card to see full details (lots, P&L, max profit/loss)

### Notifications:
- Tap **Enable Signal Notifications** in Setup tab
- You'll get a phone notification for every new signal even when app is in background

---

## Troubleshooting

**Can't reach server from phone?**
- Make sure PC and phone are on the SAME WiFi network
- Check Windows Firewall: allow Node.js or open port 3001
- Windows Firewall → Advanced → Inbound Rules → New Rule → Port 3001

**"Not authenticated" error?**
- server.js must be running
- Re-enter credentials and tap Connect

**Premiums showing EST instead of LIVE?**
- Market must be open (9:15 AM – 3:30 PM, Mon–Fri)
- Angel One session may have expired — reconnect

---

## Want to use the app anywhere (not just home WiFi)?

Deploy server.js to a free cloud host:

### Free options:
1. **Railway.app** — Free tier, simple deploy
   - Create account → New Project → Deploy from GitHub
   - Upload server.js + package.json
   - Get a public URL like `https://your-app.railway.app`

2. **Render.com** — Free tier
   - Similar process, gives public HTTPS URL

3. **Zeabur** — Free tier, easy

Once deployed, enter the cloud URL in the Setup tab instead of a local IP.
The phone app works from anywhere — mobile data, any WiFi.

---

## Files in this package

| File | Purpose |
|------|---------|
| `index.html` | Mobile PWA app (open this on your phone) |
| `manifest.json` | PWA config (name, icon, display mode) |
| `sw.js` | Service worker (offline support) |
| `icon-192.png` | App icon (192×192) |
| `icon-512.png` | App icon (512×512) |
| `server.js` | Backend proxy for Angel One API |
| `package.json` | Node.js dependencies |
| `START-WINDOWS.bat` | Start server on Windows |
| `start-mac-linux.sh` | Start server on Mac/Linux |

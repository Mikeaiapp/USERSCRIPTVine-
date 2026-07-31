Amazon Vine Explorer Master Suite 🚀
Install Userscript
The ultimate, self-correcting userscript for Amazon Vine browsing, filtering, tracking, and reselling automation.
🌟 Key Features
• Preloaded ETV Badges: Highlights FREE ($0.00) items in green and high-value items in blue directly on product tiles.
• Junk Filter ($0.01 – $25.00): Soft-hides low-margin items so you only focus on high-yield products.
• Live Discord Alerts: Pre-configured to push rich embedded alerts to your Discord channel when new $0.00 FREE or high-value items hit the feed.
• IndexedDB Local Storage: Automatically tracks seen items in a browser database (AVE_Database_v6) and lets you star ★ your favorites.
• Clean CSV Export: Downloads a structured spreadsheet containing ASINs, Recommendation IDs, titles, ETVs, product links, and image links.
• Infinite Scroll: Seamlessly merges subsequent Vine pages as you scroll down.
• Defensive Self-Correction: Automatically halts heavy execution if Amazon updates its DOM layout, displaying ⚠️ DOM Renamed. Halted. to prevent browser freezes.
📥 Quick Installation
1. Install Tampermonkey in your browser (Chrome, Edge, Safari, Lemur, or Mises).
2. Enable Developer Mode in your browser's extension settings (chrome://extensions).
3. Click the Install Script badge above.
4. Click Install when Tampermonkey opens.
⚙️ Manifest V3 / Lemur Configuration
If using Tampermonkey v5.2+ on Chromium or Mobile Browsers (Lemur/Mises):
1. Open Tampermonkey Dashboard → Settings.
2. Set Config Mode to Advanced.
3. Under Security, set Content Script API to UserScripts API Dynamic.
4. Under Downloads, set Download Mode to Browser.
🔔 Discord Webhook Setup
5. ADD your Discord webhook URL: 
To change or update your webhook URL at any time:
1. Open any Amazon Vine page (/vine/vine-items).
2. Paste your new Discord Webhook URL into the Discord Webhook URL input box on the top toolbar.
3. Click Save Discord.
📊 Export CSV Schema
When clicking Export CSV, the script generates a Blob download containing:

Column Header
Description

ASIN
Amazon Standard Identification Number

RecID
Vine Recommendation ID

Title
Full Product Title

ETV
Estimated Taxable Value ($0.00 or parsed dollar value)

Band
Item Classification (FREE, KEEP, or EXCLUDED)

URL
Direct link to product detail page

ImageURL
Direct Amazon image source URL

Timestamp
ISO 8601 extraction timestamp


🛠️ Repository File Structure
USERSCRIPTVine/
├── VineExplorer.user.js    <-- Master Userscript Code
├── README.md              <-- Full Project Documentation
├── .gitignore             <-- OS, IDE, Environment & Build Exclusions
└── LICENSE                <-- MIT Open-Source License

